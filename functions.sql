-- ═══════════════════════════════════════════════════════════════════
--  AXIION Business Manager — database functions (run AFTER schema.sql)
--  All money/stock changes happen inside these functions, so each one
--  is all-or-nothing (a half-saved invoice is impossible).
-- ═══════════════════════════════════════════════════════════════════

create or replace function setting_num(k text, d numeric default 0) returns numeric language sql stable as
$$ select coalesce((select (value #>> '{}')::numeric from settings where key = k), d) $$;
create or replace function setting_bool(k text, d boolean default false) returns boolean language sql stable as
$$ select coalesce((select (value #>> '{}')::boolean from settings where key = k), d) $$;

create or replace function shop_balance(p_id uuid) returns numeric language sql stable as
$$ select coalesce(sum(debit - credit),0) from ledger where party_type='shop' and party_id=p_id $$;
create or replace function supplier_balance(p_id uuid) returns numeric language sql stable as
$$ select coalesce(sum(credit - debit),0) from ledger where party_type='supplier' and party_id=p_id $$;

-- helper: move stock + record the movement
create or replace function _move(p_prod uuid, p_bucket text, p_date date, p_kind text, p_qty numeric,
                                 p_ref_type text, p_ref uuid, p_note text, p_by text) returns void language plpgsql as $$
begin
  if p_bucket = 'damage' then
    update products set damage_stock = damage_stock + p_qty where id = p_prod;
  else
    update products set stock = stock + p_qty where id = p_prod;
  end if;
  insert into stock_moves(product_id,bucket,date,kind,qty,ref_type,ref_id,note,by_name)
  values (p_prod,p_bucket,p_date,p_kind,p_qty,p_ref_type,p_ref,coalesce(p_note,''),coalesce(p_by,''));
end $$;

-- helper: undo everything a document did to stock and ledger
create or replace function _reverse_ref(p_ref uuid) returns void language plpgsql as $$
declare m record;
begin
  for m in select * from stock_moves where ref_id = p_ref loop
    if m.bucket = 'damage' then update products set damage_stock = damage_stock - m.qty where id = m.product_id;
    else update products set stock = stock - m.qty where id = m.product_id; end if;
  end loop;
  delete from stock_moves where ref_id = p_ref;
  delete from ledger where ref_id = p_ref;
end $$;

-- ═════════════════════════ SALE ═════════════════════════════════
create or replace function fn_post_sale(p jsonb) returns jsonb language plpgsql as $$
declare
  v_tok text := nullif(p->>'client_token','');
  v_old sales%rowtype;
  v_id uuid := gen_random_uuid();
  v_date date := coalesce(nullif(p->>'date','')::date, current_date);
  v_by text := coalesce(p->>'by_name','');
  v_shop shops%rowtype; v_has_shop boolean := false;
  v_emp_id uuid := nullif(p->>'employee_id','')::uuid; v_emp_name text := '';
  it jsonb; pr products%rowtype;
  v_units numeric; v_price numeric; v_line numeric;
  v_sub numeric := 0; v_cost numeric := 0;
  v_disc numeric := greatest(coalesce((p->>'discount')::numeric,0),0);
  v_comm numeric := greatest(coalesce((p->>'commission')::numeric,0),0);
  v_paid numeric := greatest(coalesce((p->>'paid')::numeric,0),0);
  v_method text := coalesce(nullif(p->>'method',''),'cash');
  v_total numeric; v_due numeric; v_no text; v_over boolean := false; v_bal numeric := 0;
  v_neg boolean := setting_bool('allow_negative_stock');
  v_n int := 0;
begin
  if v_tok is not null then
    select * into v_old from sales where client_token = v_tok;
    if found then
      return jsonb_build_object('id',v_old.id,'inv_no',v_old.inv_no,'total',v_old.total,'due',v_old.due,'duplicate',true);
    end if;
  end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'কমপক্ষে একটি পণ্য দিন';
  end if;
  if nullif(p->>'shop_id','') is not null then
    select * into v_shop from shops where id = (p->>'shop_id')::uuid;
    if not found then raise exception 'দোকান পাওয়া যায়নি'; end if;
    v_has_shop := true;
  end if;
  if v_emp_id is not null then select name into v_emp_name from employees where id = v_emp_id; end if;

  -- lock all products in a fixed order (no deadlocks)
  perform 1 from products where id in (select (x->>'product_id')::uuid from jsonb_array_elements(p->'items') x) order by id for update;

  v_no := coalesce(nullif(setting_text('invoice_prefix'),''),'S-') || lpad(nextval('sale_no_seq')::text, 6, '0');
  insert into sales(id,inv_no,client_token,date,shop_id,shop_name,employee_id,employee_name,method,note,by_name)
  values (v_id, v_no, v_tok, v_date, case when v_has_shop then v_shop.id end,
          case when v_has_shop then v_shop.name else coalesce(nullif(p->>'shop_name',''),'নগদ ক্রেতা') end,
          v_emp_id, coalesce(v_emp_name,''), v_method, coalesce(p->>'note',''), v_by);

  for it in select * from jsonb_array_elements(p->'items') loop
    v_units := coalesce((it->>'units')::numeric,0);
    v_price := coalesce((it->>'unit_price')::numeric,0);
    if v_units <= 0 then raise exception 'পরিমাণ ০ এর বেশি হতে হবে'; end if;
    if v_price < 0 then raise exception 'দাম ঋণাত্মক হতে পারে না'; end if;
    select * into pr from products where id = (it->>'product_id')::uuid;
    if not found then raise exception 'পণ্য পাওয়া যায়নি'; end if;
    if not v_neg and pr.stock < v_units then
      raise exception 'স্টক কম: % (আছে %, দরকার %)', pr.name, pr.stock, v_units;
    end if;
    v_line := round(v_units * v_price, 2);
    insert into sale_items(sale_id,product_id,product_name,category,units,unit_price,cost_price,line_total)
    values (v_id, pr.id, pr.name, pr.category, v_units, v_price, pr.purchase_price, v_line);
    perform _move(pr.id,'stock',v_date,'sale',-v_units,'sale',v_id,v_no,v_by);
    v_sub := v_sub + v_line; v_cost := v_cost + round(v_units * pr.purchase_price,2); v_n := v_n + 1;
  end loop;

  v_total := v_sub - v_disc - v_comm;
  if v_total < 0 then raise exception 'ছাড়/কমিশন মোট বিলের চেয়ে বেশি'; end if;
  if v_paid > v_total then raise exception 'জমা (%) বিলের (%) চেয়ে বেশি', v_paid, v_total; end if;
  v_due := v_total - v_paid;
  if v_due > 0 and not v_has_shop then raise exception 'বাকি দিতে হলে দোকান বেছে নিন'; end if;

  if v_has_shop then
    v_bal := shop_balance(v_shop.id);
    if v_shop.credit_limit > 0 and (v_bal + v_due) > v_shop.credit_limit then
      v_over := true;
      if setting_bool('enforce_credit_limit') then
        raise exception 'বাকির সীমা (%) পার হয়ে যাচ্ছে — বর্তমান বাকি %', v_shop.credit_limit, v_bal;
      end if;
    end if;
    if v_total > 0 then
      insert into ledger(party_type,party_id,party_name,date,kind,debit,ref_type,ref_id,employee_id,employee_name,note,by_name)
      values ('shop',v_shop.id,v_shop.name,v_date,'sale',v_total,'sale',v_id,v_emp_id,coalesce(v_emp_name,''),v_no,v_by);
    end if;
    if v_paid > 0 then
      insert into ledger(party_type,party_id,party_name,date,kind,credit,method,ref_type,ref_id,employee_id,employee_name,note,by_name)
      values ('shop',v_shop.id,v_shop.name,v_date,'sale_paid',v_paid,v_method,'sale',v_id,v_emp_id,coalesce(v_emp_name,''),v_no,v_by);
    end if;
  end if;

  update sales set subtotal=v_sub, discount=v_disc, commission=v_comm, total=v_total, paid=v_paid, due=v_due, cost=v_cost where id = v_id;
  return jsonb_build_object('id',v_id,'inv_no',v_no,'total',v_total,'due',v_due,'over_limit',v_over,'shop_balance',v_bal + v_due);
end $$;

create or replace function setting_text(k text) returns text language sql stable as
$$ select coalesce((select value #>> '{}' from settings where key = k), '') $$;

create or replace function fn_void_sale(p_id uuid, p_reason text, p_by text) returns jsonb language plpgsql as $$
declare s sales%rowtype;
begin
  select * into s from sales where id = p_id for update;
  if not found then raise exception 'ইনভয়েস পাওয়া যায়নি'; end if;
  if s.status = 'void' then raise exception 'ইনভয়েস আগেই বাতিল করা হয়েছে'; end if;
  perform 1 from products where id in (select product_id from sale_items where sale_id = p_id) order by id for update;
  perform _reverse_ref(p_id);
  update sales set status='void', void_reason=coalesce(p_reason,'') where id = p_id;
  return jsonb_build_object('ok',true,'inv_no',s.inv_no);
end $$;

-- ═════════════════════════ PURCHASE ═════════════════════════════
create or replace function fn_post_purchase(p jsonb) returns jsonb language plpgsql as $$
declare
  v_tok text := nullif(p->>'client_token','');
  v_old purchases%rowtype;
  v_id uuid := gen_random_uuid();
  v_date date := coalesce(nullif(p->>'date','')::date, current_date);
  v_by text := coalesce(p->>'by_name','');
  v_sup suppliers%rowtype;
  it jsonb; pr products%rowtype;
  v_units numeric; v_cost numeric; v_line numeric; v_sub numeric := 0;
  v_disc numeric := greatest(coalesce((p->>'discount')::numeric,0),0);
  v_paid numeric := greatest(coalesce((p->>'paid')::numeric,0),0);
  v_method text := coalesce(nullif(p->>'method',''),'cash');
  v_total numeric; v_no text;
begin
  if v_tok is not null then
    select * into v_old from purchases where client_token = v_tok;
    if found then return jsonb_build_object('id',v_old.id,'pur_no',v_old.pur_no,'total',v_old.total,'due',v_old.due,'duplicate',true); end if;
  end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'কমপক্ষে একটি পণ্য দিন'; end if;
  select * into v_sup from suppliers where id = nullif(p->>'supplier_id','')::uuid;
  if not found then raise exception 'কোম্পানি বেছে নিন'; end if;
  perform 1 from products where id in (select (x->>'product_id')::uuid from jsonb_array_elements(p->'items') x) order by id for update;

  v_no := 'P-' || lpad(nextval('purchase_no_seq')::text, 6, '0');
  insert into purchases(id,pur_no,client_token,date,slip_no,supplier_id,supplier_name,method,note,by_name)
  values (v_id,v_no,v_tok,v_date,coalesce(p->>'slip_no',''),v_sup.id,v_sup.name,v_method,coalesce(p->>'note',''),v_by);

  for it in select * from jsonb_array_elements(p->'items') loop
    v_units := coalesce((it->>'units')::numeric,0);
    v_cost  := coalesce((it->>'unit_cost')::numeric,0);
    if v_units <= 0 then raise exception 'পরিমাণ ০ এর বেশি হতে হবে'; end if;
    select * into pr from products where id = (it->>'product_id')::uuid;
    if not found then raise exception 'পণ্য পাওয়া যায়নি'; end if;
    v_line := round(v_units * v_cost, 2);
    insert into purchase_items(purchase_id,product_id,product_name,units,unit_cost,line_total)
    values (v_id,pr.id,pr.name,v_units,v_cost,v_line);
    perform _move(pr.id,'stock',v_date,'purchase',v_units,'purchase',v_id,v_no,v_by);
    if setting_bool('update_cost_on_purchase', true) and v_cost > 0 then
      update products set purchase_price = v_cost where id = pr.id;
    end if;
    v_sub := v_sub + v_line;
  end loop;

  v_total := v_sub - v_disc;
  if v_total < 0 then raise exception 'ছাড় মোট বিলের চেয়ে বেশি'; end if;
  if v_paid > v_total then raise exception 'পরিশোধ (%) বিলের (%) চেয়ে বেশি', v_paid, v_total; end if;
  if v_total > 0 then
    insert into ledger(party_type,party_id,party_name,date,kind,credit,ref_type,ref_id,note,by_name)
    values ('supplier',v_sup.id,v_sup.name,v_date,'purchase',v_total,'purchase',v_id,v_no,v_by);
  end if;
  if v_paid > 0 then
    insert into ledger(party_type,party_id,party_name,date,kind,debit,method,ref_type,ref_id,note,by_name)
    values ('supplier',v_sup.id,v_sup.name,v_date,'purchase_paid',v_paid,v_method,'purchase',v_id,v_no,v_by);
  end if;
  update purchases set subtotal=v_sub, discount=v_disc, total=v_total, paid=v_paid, due=v_total-v_paid where id = v_id;
  return jsonb_build_object('id',v_id,'pur_no',v_no,'total',v_total,'due',v_total-v_paid);
end $$;

create or replace function fn_void_purchase(p_id uuid, p_reason text, p_by text) returns jsonb language plpgsql as $$
declare s purchases%rowtype; bad text;
begin
  select * into s from purchases where id = p_id for update;
  if not found then raise exception 'ক্রয় পাওয়া যায়নি'; end if;
  if s.status = 'void' then raise exception 'আগেই বাতিল করা হয়েছে'; end if;
  perform 1 from products where id in (select product_id from purchase_items where purchase_id = p_id) order by id for update;
  select string_agg(pr.name, ', ') into bad
    from purchase_items pi join products pr on pr.id = pi.product_id
   where pr.stock < pi.units and not setting_bool('allow_negative_stock');
  if bad is not null then raise exception 'বাতিল করা যাবে না — স্টকে এখন যথেষ্ট নেই: %', bad; end if;
  perform _reverse_ref(p_id);
  update purchases set status='void', void_reason=coalesce(p_reason,'') where id = p_id;
  return jsonb_build_object('ok',true,'pur_no',s.pur_no);
end $$;

-- ═════════════ RETURNS / DAMAGE / CLAIMS / STOCK ADJUST ═════════
-- p.kind: sale_return | shop_damage | company_return | store_damage | company_claim | stock_adjust
create or replace function fn_post_adjustment(p jsonb) returns jsonb language plpgsql as $$
declare
  v_tok text := nullif(p->>'client_token','');
  v_old adjustments%rowtype;
  v_id uuid := gen_random_uuid();
  v_kind text := p->>'kind';
  v_date date := coalesce(nullif(p->>'date','')::date, current_date);
  v_by text := coalesce(p->>'by_name','');
  v_mode text := coalesce(p->>'mode','credit');
  v_method text := coalesce(nullif(p->>'method',''),'cash');
  v_shop shops%rowtype; v_sup suppliers%rowtype;
  v_emp_id uuid := nullif(p->>'employee_id','')::uuid; v_emp_name text := '';
  it jsonb; pr products%rowtype; v_units numeric; v_price numeric;
  v_amount numeric := 0; v_ex numeric := 0; v_no text;
  v_items jsonb := '[]'::jsonb; v_exitems jsonb := '[]'::jsonb;
  v_neg boolean := setting_bool('allow_negative_stock');
  v_pname text := '';
begin
  if v_tok is not null then
    select * into v_old from adjustments where client_token = v_tok;
    if found then return jsonb_build_object('id',v_old.id,'adj_no',v_old.adj_no,'amount',v_old.amount,'duplicate',true); end if;
  end if;
  if v_kind not in ('sale_return','shop_damage','company_return','store_damage','company_claim','stock_adjust') then raise exception 'অজানা ধরন'; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'কমপক্ষে একটি পণ্য দিন'; end if;
  if v_emp_id is not null then select name into v_emp_name from employees where id = v_emp_id; end if;

  if v_kind in ('sale_return','shop_damage') then
    select * into v_shop from shops where id = nullif(p->>'party_id','')::uuid;
    if not found then raise exception 'দোকান বেছে নিন'; end if;
    v_pname := v_shop.name;
  elsif v_kind in ('company_return','company_claim') then
    select * into v_sup from suppliers where id = nullif(p->>'party_id','')::uuid;
    if not found then raise exception 'কোম্পানি বেছে নিন'; end if;
    v_pname := v_sup.name;
  end if;

  perform 1 from products where id in (
     select (x->>'product_id')::uuid from jsonb_array_elements(p->'items' || coalesce(p->'exch_items','[]'::jsonb)) x) order by id for update;
  v_no := 'A-' || lpad(nextval('adj_no_seq')::text, 6, '0');
  insert into adjustments(id,adj_no,client_token,kind,date,party_type,party_id,party_name,employee_id,employee_name,mode,method,note,by_name)
  values (v_id,v_no,v_tok,v_kind,v_date,
          case when v_kind in ('sale_return','shop_damage') then 'shop' when v_kind in ('company_return','company_claim') then 'supplier' else '' end,
          nullif(p->>'party_id','')::uuid, v_pname, v_emp_id, coalesce(v_emp_name,''), v_mode, v_method, coalesce(p->>'note',''), v_by);

  for it in select * from jsonb_array_elements(p->'items') loop
    v_units := coalesce((it->>'units')::numeric,0);
    if v_kind = 'stock_adjust' then
      if v_units = 0 then raise exception 'পরিমাণ ০ হতে পারে না'; end if;
    elsif v_units <= 0 then raise exception 'পরিমাণ ০ এর বেশি হতে হবে'; end if;
    select * into pr from products where id = (it->>'product_id')::uuid;
    if not found then raise exception 'পণ্য পাওয়া যায়নি'; end if;
    v_price := coalesce(nullif(it->>'price','')::numeric,
                 case when v_kind in ('company_return','company_claim','store_damage','stock_adjust') then pr.purchase_price else pr.selling_price end);
    v_amount := v_amount + round(abs(v_units) * v_price, 2);
    v_items := v_items || jsonb_build_object('product_id',pr.id,'name',pr.name,'units',v_units,'price',v_price);

    if v_kind = 'sale_return' then
      perform _move(pr.id,'stock',v_date,'sale_return',v_units,'adj',v_id,v_no,v_by);
    elsif v_kind = 'shop_damage' then
      perform _move(pr.id,'damage',v_date,'shop_damage',v_units,'adj',v_id,v_no,v_by);
    elsif v_kind = 'company_return' then
      if not v_neg and pr.stock < v_units then raise exception 'স্টক কম: % (আছে %)', pr.name, pr.stock; end if;
      perform _move(pr.id,'stock',v_date,'company_return',-v_units,'adj',v_id,v_no,v_by);
    elsif v_kind = 'store_damage' then
      if not v_neg and pr.stock < v_units then raise exception 'স্টক কম: % (আছে %)', pr.name, pr.stock; end if;
      perform _move(pr.id,'stock',v_date,'store_damage',-v_units,'adj',v_id,v_no,v_by);
      perform _move(pr.id,'damage',v_date,'store_damage',v_units,'adj',v_id,v_no,v_by);
    elsif v_kind = 'company_claim' then
      if pr.damage_stock < v_units then raise exception 'ড্যামেজ স্টকে কম: % (আছে %)', pr.name, pr.damage_stock; end if;
      perform _move(pr.id,'damage',v_date,'company_claim',-v_units,'adj',v_id,v_no,v_by);
      if v_mode = 'replace' then
        perform _move(pr.id,'stock',v_date,'claim_replace',v_units,'adj',v_id,v_no,v_by);
      end if;
    elsif v_kind = 'stock_adjust' then
      if v_units < 0 and not v_neg and pr.stock < -v_units then raise exception 'স্টক কম: % (আছে %)', pr.name, pr.stock; end if;
      perform _move(pr.id,'stock',v_date,'adjust',v_units,'adj',v_id,coalesce(p->>'note',v_no),v_by);
    end if;
  end loop;

  -- exchange: replacement goods given to the shop
  if v_kind = 'shop_damage' and v_mode = 'exchange' then
    for it in select * from jsonb_array_elements(coalesce(p->'exch_items','[]'::jsonb)) loop
      v_units := coalesce((it->>'units')::numeric,0);
      if v_units <= 0 then continue; end if;
      select * into pr from products where id = (it->>'product_id')::uuid;
      if not found then raise exception 'বদলি পণ্য পাওয়া যায়নি'; end if;
      if not v_neg and pr.stock < v_units then raise exception 'স্টক কম: % (আছে %)', pr.name, pr.stock; end if;
      v_price := coalesce(nullif(it->>'price','')::numeric, pr.selling_price);
      v_ex := v_ex + round(v_units * v_price, 2);
      v_exitems := v_exitems || jsonb_build_object('product_id',pr.id,'name',pr.name,'units',v_units,'price',v_price);
      perform _move(pr.id,'stock',v_date,'exchange_out',-v_units,'adj',v_id,v_no,v_by);
    end loop;
  end if;

  -- money side
  if v_kind in ('sale_return','shop_damage') then
    if v_amount > 0 then
      insert into ledger(party_type,party_id,party_name,date,kind,credit,ref_type,ref_id,employee_id,employee_name,note,by_name)
      values ('shop',v_shop.id,v_shop.name,v_date, case when v_kind='sale_return' then 'return' else 'damage' end, v_amount,'adj',v_id,v_emp_id,coalesce(v_emp_name,''),v_no,v_by);
    end if;
    if v_mode = 'refund' and v_amount > 0 then
      insert into ledger(party_type,party_id,party_name,date,kind,debit,method,ref_type,ref_id,note,by_name)
      values ('shop',v_shop.id,v_shop.name,v_date,'refund',v_amount,v_method,'adj',v_id,v_no,v_by);
    elsif v_mode = 'exchange' and v_ex > 0 then
      insert into ledger(party_type,party_id,party_name,date,kind,debit,ref_type,ref_id,note,by_name)
      values ('shop',v_shop.id,v_shop.name,v_date,'exchange',v_ex,'adj',v_id,v_no,v_by);
    end if;
  elsif v_kind = 'company_return' and v_amount > 0 then
    insert into ledger(party_type,party_id,party_name,date,kind,debit,ref_type,ref_id,note,by_name)
    values ('supplier',v_sup.id,v_sup.name,v_date,'return',v_amount,'adj',v_id,v_no,v_by);
  elsif v_kind = 'company_claim' and v_mode = 'credit' and v_amount > 0 then
    insert into ledger(party_type,party_id,party_name,date,kind,debit,ref_type,ref_id,note,by_name)
    values ('supplier',v_sup.id,v_sup.name,v_date,'claim',v_amount,'adj',v_id,v_no,v_by);
  end if;

  update adjustments set items = v_items, exch_items = v_exitems, amount = v_amount where id = v_id;
  return jsonb_build_object('id',v_id,'adj_no',v_no,'amount',v_amount);
end $$;

create or replace function fn_void_adjustment(p_id uuid, p_by text) returns jsonb language plpgsql as $$
declare a adjustments%rowtype; bad text;
begin
  select * into a from adjustments where id = p_id for update;
  if not found then raise exception 'রেকর্ড পাওয়া যায়নি'; end if;
  if a.status = 'void' then raise exception 'আগেই বাতিল করা হয়েছে'; end if;
  perform 1 from products where id in (select product_id from stock_moves where ref_id = p_id) order by id for update;
  perform _reverse_ref(p_id);
  update adjustments set status='void' where id = p_id;
  return jsonb_build_object('ok',true,'adj_no',a.adj_no);
end $$;

-- ═════════════════════════ REPORTS ══════════════════════════════
-- every cash/bank movement in one place
create or replace view money_flow as
  select l.date, 'in'::text as dir, l.credit as amount, coalesce(nullif(l.method,''),'cash') as method,
         case l.kind when 'collection' then 'বাকি আদায়' else 'বিক্রয় (জমা)' end as src,
         l.party_name as who, l.note, l.created_at
    from ledger l where l.party_type='shop' and l.kind in ('collection','sale_paid') and l.credit > 0
  union all
  select s.date, 'in', s.paid, coalesce(nullif(s.method,''),'cash'), 'নগদ বিক্রয়', s.shop_name, s.inv_no, s.created_at
    from sales s where s.shop_id is null and s.status='ok' and s.paid > 0
  union all
  select l.date, 'out', l.debit, coalesce(nullif(l.method,''),'cash'), 'ফেরত বাবদ পরিশোধ', l.party_name, l.note, l.created_at
    from ledger l where l.party_type='shop' and l.kind='refund' and l.debit > 0
  union all
  select l.date, 'out', l.debit, coalesce(nullif(l.method,''),'cash'),
         case l.kind when 'payment' then 'কোম্পানিকে পরিশোধ' else 'ক্রয় (পরিশোধ)' end, l.party_name, l.note, l.created_at
    from ledger l where l.party_type='supplier' and l.kind in ('payment','purchase_paid') and l.debit > 0
  union all
  select e.date, 'out', e.amount, e.method, 'খরচ: ' || e.category, e.employee_name, e.note, e.created_at from expenses e
  union all
  select s.date, 'out', s.amount, s.method,
         case s.kind when 'advance' then 'অগ্রিম বেতন' when 'bonus' then 'বোনাস' else 'বেতন' end, s.employee_name, s.note, s.created_at from salary_payments s
  union all
  select c.date, c.direction, c.amount, c.method,
         case c.kind when 'capital_in' then 'মূলধন জমা' when 'owner_withdraw' then 'মালিকের উত্তোলন'
              when 'bank_deposit' then 'ব্যাংকে জমা' when 'bank_withdraw' then 'ব্যাংক থেকে তোলা'
              when 'other_income' then 'অন্যান্য আয়' else 'অন্যান্য ব্যয়' end, '', c.note, c.created_at from cash_entries c;

create or replace function fn_cashbook(p_from date, p_to date) returns jsonb language plpgsql stable as $$
declare
  v_ob numeric := setting_num('opening_bank'); v_oc numeric := setting_num('opening_cash');
  v_start date := coalesce(nullif(setting_text('books_start'),'')::date, date '2000-01-01');
  v_cash_open numeric; v_bank_open numeric; rows jsonb; v_cin numeric; v_cout numeric; v_bin numeric; v_bout numeric;
begin
  select v_oc + coalesce(sum(case when dir='in' then amount else -amount end),0) into v_cash_open
    from money_flow where method='cash' and date >= v_start and date < p_from;
  select v_ob + coalesce(sum(case when dir='in' then amount else -amount end),0) into v_bank_open
    from money_flow where method<>'cash' and date >= v_start and date < p_from;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.date, r.created_at),'[]') into rows
    from (select date,dir,amount,method,src,who,note,created_at from money_flow where date between p_from and p_to) r;
  select coalesce(sum(amount) filter (where dir='in' and method='cash'),0), coalesce(sum(amount) filter (where dir='out' and method='cash'),0),
         coalesce(sum(amount) filter (where dir='in' and method<>'cash'),0), coalesce(sum(amount) filter (where dir='out' and method<>'cash'),0)
    into v_cin,v_cout,v_bin,v_bout from money_flow where date between p_from and p_to;
  return jsonb_build_object('rows',rows,
    'cash_open',v_cash_open,'cash_in',v_cin,'cash_out',v_cout,'cash_close',v_cash_open+v_cin-v_cout,
    'bank_open',v_bank_open,'bank_in',v_bin,'bank_out',v_bout,'bank_close',v_bank_open+v_bin-v_bout);
end $$;

create or replace function fn_dashboard(p_date date) returns jsonb language plpgsql stable as $$
declare
  v_m0 date := date_trunc('month', p_date)::date;
  v_today jsonb; v_month jsonb; v_series jsonb; v_low jsonb; v_topshops jsonb; v_topprods jsonb; v_cb jsonb; v_over jsonb;
begin
  select jsonb_build_object('sales',coalesce(sum(total),0),'count',count(*),'paid',coalesce(sum(paid),0),'due',coalesce(sum(due),0),
                            'profit',coalesce(sum(total - cost),0)) into v_today
    from sales where status='ok' and date = p_date;
  v_today := v_today || jsonb_build_object(
     'collection', (select coalesce(sum(credit),0) from ledger where party_type='shop' and kind='collection' and date=p_date),
     'expense',    (select coalesce(sum(amount),0) from expenses where date=p_date),
     'purchase',   (select coalesce(sum(total),0) from purchases where status='ok' and date=p_date));
  select jsonb_build_object('sales',coalesce(sum(total),0),'count',count(*),'profit',coalesce(sum(total - cost),0)) into v_month
    from sales where status='ok' and date between v_m0 and p_date;
  v_month := v_month || jsonb_build_object(
     'collection', (select coalesce(sum(credit),0) from ledger where party_type='shop' and kind='collection' and date between v_m0 and p_date),
     'expense',    (select coalesce(sum(amount),0) from expenses where date between v_m0 and p_date),
     'target',     setting_num('monthly_target'));
  select coalesce(jsonb_agg(jsonb_build_object('date',d::date,'sales',coalesce(s.t,0)) order by d),'[]') into v_series
    from generate_series(p_date - 6, p_date, interval '1 day') d
    left join (select date, sum(total) t from sales where status='ok' and date >= p_date - 6 group by date) s on s.date = d::date;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'stock',stock,'low',low_stock,'case_size',case_size) order by stock),'[]') into v_low
    from (select * from products where active and low_stock > 0 and stock <= low_stock order by stock limit 12) x;
  select coalesce(jsonb_agg(jsonb_build_object('shop_id',shop_id,'name',shop_name,'total',t) order by t desc),'[]') into v_topshops
    from (select shop_id, shop_name, sum(total) t from sales where status='ok' and shop_id is not null and date between v_m0 and p_date group by 1,2 order by t desc limit 5) x;
  select coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'name',product_name,'units',u,'total',t) order by t desc),'[]') into v_topprods
    from (select si.product_id, si.product_name, sum(si.units) u, sum(si.line_total) t from sale_items si join sales s on s.id=si.sale_id
           where s.status='ok' and s.date between v_m0 and p_date group by 1,2 order by t desc limit 5) x;
  v_cb := fn_cashbook(p_date, p_date);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'phone',phone,'bal',bal,'promise',promise_date) order by bal desc),'[]') into v_over
    from (select s.id, s.name, s.phone, s.promise_date, shop_balance(s.id) bal from shops s
           where s.active and s.promise_date is not null and s.promise_date <= p_date and shop_balance(s.id) > 0
           order by shop_balance(s.id) desc limit 8) x;
  return jsonb_build_object('today',v_today,'month',v_month,'series',v_series,'low_stock',v_low,
    'top_shops',v_topshops,'top_products',v_topprods,
    'cash_close',(v_cb->>'cash_close')::numeric,'bank_close',(v_cb->>'bank_close')::numeric,
    'receivable',(select coalesce(sum(b),0) from (select shop_balance(id) b from shops) q where b>0),
    'payable',(select coalesce(sum(b),0) from (select supplier_balance(id) b from suppliers) q where b>0),
    'stock_cost',(select coalesce(sum(stock*purchase_price),0) from products where active),
    'stock_sell',(select coalesce(sum(stock*selling_price),0) from products where active),
    'damage_value',(select coalesce(sum(damage_stock*purchase_price),0) from products),
    'promise_due',v_over);
end $$;

create or replace function fn_report_summary(p_from date, p_to date) returns jsonb language plpgsql stable as $$
declare v jsonb; ex jsonb; days jsonb;
begin
  select jsonb_build_object('gross',coalesce(sum(subtotal),0),'discount',coalesce(sum(discount),0),'commission',coalesce(sum(commission),0),
         'net',coalesce(sum(total),0),'cost',coalesce(sum(cost),0),'invoices',count(*),'paid',coalesce(sum(paid),0),'due',coalesce(sum(due),0)) into v
    from sales where status='ok' and date between p_from and p_to;
  v := v || jsonb_build_object(
    'returns',(select coalesce(sum(amount),0) from adjustments where status='ok' and kind='sale_return' and date between p_from and p_to),
    'returns_cost',(select coalesce(sum((i->>'units')::numeric * coalesce(pr.purchase_price,0)),0) from adjustments a, jsonb_array_elements(a.items) i
                      left join products pr on pr.id = (i->>'product_id')::uuid
                      where a.status='ok' and a.kind='sale_return' and a.date between p_from and p_to),
    'shop_damage',(select coalesce(sum(amount),0) from adjustments where status='ok' and kind='shop_damage' and date between p_from and p_to),
    'collection',(select coalesce(sum(credit),0) from ledger where party_type='shop' and kind='collection' and date between p_from and p_to),
    'purchases',(select coalesce(sum(total),0) from purchases where status='ok' and date between p_from and p_to),
    'expenses',(select coalesce(sum(amount),0) from expenses where date between p_from and p_to),
    'salary',(select coalesce(sum(amount),0) from salary_payments where date between p_from and p_to));
  select coalesce(jsonb_agg(jsonb_build_object('category',category,'amount',a) order by a desc),'[]') into ex
    from (select category, sum(amount) a from expenses where date between p_from and p_to group by 1) q;
  select coalesce(jsonb_agg(jsonb_build_object('date',date,'sales',t,'count',c,'profit',pf) order by date),'[]') into days
    from (select date, sum(total) t, count(*) c, sum(total-cost) pf from sales where status='ok' and date between p_from and p_to group by 1) q;
  return v || jsonb_build_object('expense_by_cat',ex,'by_day',days);
end $$;

-- dim: product | shop | employee | category | area
create or replace function fn_report_by(p_from date, p_to date, p_dim text) returns jsonb language plpgsql stable as $$
declare r jsonb;
begin
  if p_dim = 'product' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.total desc),'[]') into r from (
      select si.product_id as id, si.product_name as name, sum(si.units) as units, sum(si.line_total) as total,
             sum(si.line_total - si.units*si.cost_price) as profit
        from sale_items si join sales s on s.id=si.sale_id where s.status='ok' and s.date between p_from and p_to group by 1,2) x;
  elsif p_dim = 'category' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.total desc),'[]') into r from (
      select coalesce(nullif(si.category,''),'(নেই)') as name, sum(si.units) as units, sum(si.line_total) as total,
             sum(si.line_total - si.units*si.cost_price) as profit
        from sale_items si join sales s on s.id=si.sale_id where s.status='ok' and s.date between p_from and p_to group by 1) x;
  elsif p_dim = 'shop' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.total desc),'[]') into r from (
      select coalesce(shop_id::text,'') as id, shop_name as name, count(*) as invoices, sum(total) as total, sum(paid) as paid, sum(due) as due, sum(total-cost) as profit
        from sales where status='ok' and date between p_from and p_to group by shop_id, shop_name) x;
  elsif p_dim = 'employee' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.total desc),'[]') into r from (
      select coalesce(nullif(employee_name,''),'(কেউ না)') as name, count(*) as invoices, sum(total) as total, sum(paid) as paid, sum(due) as due,
             (select coalesce(sum(l.credit),0) from ledger l where l.kind='collection' and l.date between p_from and p_to
                and coalesce(nullif(l.employee_name,''),'(কেউ না)') = coalesce(nullif(s.employee_name,''),'(কেউ না)')) as collected
        from sales s where status='ok' and date between p_from and p_to group by employee_name) x;
  elsif p_dim = 'area' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.total desc),'[]') into r from (
      select coalesce(nullif(sh.area,''),'(এলাকা নেই)') as name, count(*) as invoices, sum(s.total) as total, sum(s.due) as due
        from sales s left join shops sh on sh.id = s.shop_id where s.status='ok' and s.date between p_from and p_to group by 1) x;
  else raise exception 'অজানা রিপোর্ট';
  end if;
  return r;
end $$;

-- every shop with its balance, last activity and age
create or replace function fn_dues(p_only_positive boolean default true) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.balance desc),'[]') from (
    select s.id, s.code, s.name, s.keeper, s.phone, s.area, s.address, s.credit_limit, s.promise_date, s.employee_name,
           b.balance,
           (select max(date) from ledger where party_type='shop' and party_id=s.id and kind='sale') as last_sale,
           (select max(date) from ledger where party_type='shop' and party_id=s.id and kind='collection') as last_collection,
           (select min(date) from ledger l where l.party_type='shop' and l.party_id=s.id and l.kind in ('sale','opening')
               and l.debit > 0) as first_open,
           coalesce(current_date - (select max(date) from ledger where party_type='shop' and party_id=s.id and kind in ('collection','sale_paid')),
                    current_date - (select min(date) from ledger where party_type='shop' and party_id=s.id)) as days_since_pay
      from shops s cross join lateral (select shop_balance(s.id) as balance) b
     where s.active and (not p_only_positive or b.balance > 0)
  ) x
$$;

create or replace function fn_stock_report() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'sku',sku,'category',category,'case_size',case_size,'case_name',case_name,'unit_name',unit_name,
        'stock',stock,'damage',damage_stock,'low',low_stock,'cost',purchase_price,'price',selling_price,'active',active,
        'value_cost',round(stock*purchase_price,2),'value_sell',round(stock*selling_price,2)) order by category, name),'[]'),
    'total_cost', coalesce(sum(stock*purchase_price) filter (where active),0),
    'total_sell', coalesce(sum(stock*selling_price) filter (where active),0))
  from products
$$;

-- rebuild product stock from the movement history (repair tool)
create or replace function fn_resync_stock() returns integer language plpgsql as $$
declare n integer;
begin
  update products p set
    stock        = coalesce((select sum(qty) from stock_moves m where m.product_id=p.id and m.bucket='stock'),0),
    damage_stock = coalesce((select sum(qty) from stock_moves m where m.product_id=p.id and m.bucket='damage'),0);
  get diagnostics n = row_count; return n;
end $$;

-- ── only the server may call these ─────────────────────────────────
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and (p.proname like 'fn\_%' escape '\' or p.proname like '\_%' escape '\' or p.proname in ('shop_balance','supplier_balance','setting_num','setting_bool','setting_text')) loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname='anon') then execute format('revoke all on function %s from anon', f.sig); end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on function %s from authenticated', f.sig); end if;
    if exists (select 1 from pg_roles where rolname='service_role') then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then revoke all on money_flow from anon; end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then revoke all on money_flow from authenticated; end if;
end $$;

-- next shop code (SHOP-0001 …)
create or replace function fn_next_shop_code() returns text language sql as
$$ select 'SHOP-' || lpad(nextval('shop_code_seq')::text, 4, '0') $$;
revoke all on function fn_next_shop_code() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then revoke all on function fn_next_shop_code() from anon; end if;
  if exists (select 1 from pg_roles where rolname='service_role') then grant execute on function fn_next_shop_code() to service_role; end if;
end $$;

create or replace function fn_supplier_balances() returns jsonb language sql stable as
$$ select coalesce(jsonb_agg(jsonb_build_object('id',id,'balance',supplier_balance(id))),'[]') from suppliers $$;
revoke all on function fn_supplier_balances() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then revoke all on function fn_supplier_balances() from anon; end if;
  if exists (select 1 from pg_roles where rolname='service_role') then grant execute on function fn_supplier_balances() to service_role; end if;
end $$;

-- monthly salary sheet. month = 'YYYY-MM'
create or replace function fn_salary_month(p_month text) returns jsonb language plpgsql stable as $$
declare d0 date := (p_month || '-01')::date; d1 date := ((p_month || '-01')::date + interval '1 month - 1 day')::date;
        ded boolean := setting_bool('salary_deduct_absent', true);
begin
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (
    select e.id, e.name, e.designation, e.salary,
      (select count(*) from attendance a where a.employee_id=e.id and a.date between d0 and d1 and a.status='present') as present,
      (select count(*) from attendance a where a.employee_id=e.id and a.date between d0 and d1 and a.status='absent')  as absent,
      (select count(*) from attendance a where a.employee_id=e.id and a.date between d0 and d1 and a.status='late')    as late,
      (select count(*) from attendance a where a.employee_id=e.id and a.date between d0 and d1 and a.status='leave')   as leave,
      (select count(*) from attendance a where a.employee_id=e.id and a.date between d0 and d1 and a.status='half')    as half,
      case when ded then round(e.salary / 30.0 * ((select count(*) from attendance a where a.employee_id=e.id and a.date between d0 and d1 and a.status='absent')
                       + 0.5 * (select count(*) from attendance a where a.employee_id=e.id and a.date between d0 and d1 and a.status='half')),2) else 0 end as deduction,
      coalesce((select sum(amount) from salary_payments s where s.employee_id=e.id and s.month=p_month and s.kind='salary'),0)  as paid_salary,
      coalesce((select sum(amount) from salary_payments s where s.employee_id=e.id and s.month=p_month and s.kind='advance'),0) as advance,
      coalesce((select sum(amount) from salary_payments s where s.employee_id=e.id and s.month=p_month and s.kind='bonus'),0)   as bonus
    from employees e where e.active) x), '[]'::jsonb);
end $$;
revoke all on function fn_salary_month(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then revoke all on function fn_salary_month(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname='service_role') then grant execute on function fn_salary_month(text) to service_role; end if;
end $$;
