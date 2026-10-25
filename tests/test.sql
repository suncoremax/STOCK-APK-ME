\set ON_ERROR_STOP on
create or replace function t_assert(cond boolean, msg text) returns void language plpgsql as $$ begin if not coalesce(cond,false) then raise exception 'FAIL: %', msg; end if; end $$;
insert into suppliers(id,name) values ('00000000-0000-0000-0000-0000000000a1','Co A');
insert into shops(id,code,name,credit_limit) values ('00000000-0000-0000-0000-0000000000b1','SHOP-1','Rahim Store',5000);
insert into employees(id,name,designation,salary) values ('00000000-0000-0000-0000-0000000000c1','Karim','DSR',12000);
insert into products(id,name,case_size,purchase_price,selling_price,low_stock) values
 ('00000000-0000-0000-0000-0000000000d1','Soap',12,10,15,20),('00000000-0000-0000-0000-0000000000d2','Oil',6,100,120,0);

-- purchase 100 soap @9 (paid 300) -> payable 600
select fn_post_purchase('{"supplier_id":"00000000-0000-0000-0000-0000000000a1","paid":300,"method":"cash","client_token":"p1",
 "items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":100,"unit_cost":9},{"product_id":"00000000-0000-0000-0000-0000000000d2","units":10,"unit_cost":100}]}'::jsonb) \gset p_
select t_assert((select stock from products where id='00000000-0000-0000-0000-0000000000d1')=100,'stock after purchase');
select t_assert((select purchase_price from products where id='00000000-0000-0000-0000-0000000000d1')=9,'cost updated');
select t_assert(supplier_balance('00000000-0000-0000-0000-0000000000a1')=1600,'payable '||supplier_balance('00000000-0000-0000-0000-0000000000a1'));

-- idempotent
select (fn_post_purchase('{"supplier_id":"00000000-0000-0000-0000-0000000000a1","client_token":"p1","items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":5,"unit_cost":9}]}'::jsonb)->>'duplicate')::boolean as dup \gset
select t_assert(:'dup'='t','duplicate purchase blocked');
select t_assert((select stock from products where id='00000000-0000-0000-0000-0000000000d1')=100,'stock unchanged by duplicate');

-- sale 40 soap @15 = 600, disc 20, comm 10 -> 570, paid 200 -> due 370
select fn_post_sale('{"shop_id":"00000000-0000-0000-0000-0000000000b1","employee_id":"00000000-0000-0000-0000-0000000000c1","discount":20,"commission":10,"paid":200,"method":"cash","client_token":"s1",
 "items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":40,"unit_price":15}]}'::jsonb)->>'id' as sid \gset
select t_assert((select stock from products where id='00000000-0000-0000-0000-0000000000d1')=60,'stock after sale');
select t_assert(shop_balance('00000000-0000-0000-0000-0000000000b1')=370,'shop due 370');
select t_assert((select total from sales where id=:'sid')=570,'sale total');
select t_assert((select cost from sales where id=:'sid')=360,'sale cost 40*9');

-- not enough stock
do $$ begin
  perform fn_post_sale('{"shop_id":"00000000-0000-0000-0000-0000000000b1","paid":0,"items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":500,"unit_price":15}]}'::jsonb);
  raise exception 'FAIL: oversell allowed';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; end $$;
-- due w/o shop
do $$ begin
  perform fn_post_sale('{"paid":0,"items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":1,"unit_price":15}]}'::jsonb);
  raise exception 'FAIL: walk-in due allowed';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; end $$;
select t_assert((select stock from products where id='00000000-0000-0000-0000-0000000000d1')=60,'failed sales rolled back');

-- walk-in cash sale
select fn_post_sale('{"shop_name":"Walk-in","paid":150,"items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":10,"unit_price":15}]}'::jsonb) is not null as ok \gset

-- credit limit warning
select (fn_post_sale('{"shop_id":"00000000-0000-0000-0000-0000000000b1","paid":0,"items":[{"product_id":"00000000-0000-0000-0000-0000000000d2","units":1,"unit_price":6000}]}'::jsonb)->>'over_limit') as ol \gset

select t_assert(:'ol'='true','over limit flagged');
-- shop return 5 soap credit ; shop damage 2 credit
select fn_post_adjustment('{"kind":"sale_return","party_id":"00000000-0000-0000-0000-0000000000b1","mode":"credit","items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":5}]}'::jsonb) as r1 \gset
select t_assert((select stock from products where id='00000000-0000-0000-0000-0000000000d1')=55,'stock after return (60-10+5)');
select fn_post_adjustment('{"kind":"shop_damage","party_id":"00000000-0000-0000-0000-0000000000b1","mode":"credit","items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":2}]}'::jsonb) as r2 \gset
select t_assert((select damage_stock from products where id='00000000-0000-0000-0000-0000000000d1')=2,'damage stock');
-- company claim 2 -> credit
select fn_post_adjustment('{"kind":"company_claim","party_id":"00000000-0000-0000-0000-0000000000a1","mode":"credit","items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":2}]}'::jsonb) as r3 \gset
select t_assert((select damage_stock from products where id='00000000-0000-0000-0000-0000000000d1')=0,'damage cleared');
-- company return
select fn_post_adjustment('{"kind":"company_return","party_id":"00000000-0000-0000-0000-0000000000a1","items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":5}]}'::jsonb) as r4 \gset
select t_assert((select stock from products where id='00000000-0000-0000-0000-0000000000d1')=50,'stock after company return');
-- stock adjust -3
select fn_post_adjustment('{"kind":"stock_adjust","note":"count","items":[{"product_id":"00000000-0000-0000-0000-0000000000d1","units":-3}]}'::jsonb) as r5 \gset
select t_assert((select stock from products where id='00000000-0000-0000-0000-0000000000d1')=47,'stock after adjust');
-- resync equals
select fn_resync_stock();
select t_assert((select stock from products where id='00000000-0000-0000-0000-0000000000d1')=47,'resync matches');

-- collection
insert into ledger(party_type,party_id,party_name,date,kind,credit,method) values ('shop','00000000-0000-0000-0000-0000000000b1','Rahim Store',current_date,'collection',100,'bkash');

-- void sale restores
select fn_void_sale(:'sid'::uuid,'test','me');
select t_assert((select stock from products where id='00000000-0000-0000-0000-0000000000d1')=87,'stock after void (47+40)');
select t_assert((select count(*) from ledger where ref_id=:'sid'::uuid)=0,'ledger cleared on void');
do $$ begin perform fn_void_sale((select id from sales where inv_no='S-000001'),'x','y'); raise exception 'FAIL: double void';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; end $$;

-- reports run and make sense
select t_assert((fn_dashboard(current_date)->'today'->>'sales')::numeric > 0,'dashboard sales');
select t_assert(jsonb_array_length(fn_dashboard(current_date)->'series')=7,'series 7 days');
select fn_report_summary(current_date-30,current_date) as rs \gset
select fn_report_by(current_date-30,current_date,'product') as rp \gset
select fn_report_by(current_date-30,current_date,'shop') as rsh \gset
select fn_report_by(current_date-30,current_date,'employee') as re \gset
select fn_report_by(current_date-30,current_date,'category') as rc \gset
select fn_report_by(current_date-30,current_date,'area') as ra \gset
select fn_dues() as d \gset
select fn_stock_report() as sr \gset
select fn_cashbook(current_date-1,current_date) as cb \gset
select t_assert((fn_cashbook(current_date,current_date)->>'cash_in')::numeric = 150,'cash in today = walk-in 150 only (purchase out 300, collection via bkash)');
select t_assert((fn_cashbook(current_date,current_date)->>'cash_out')::numeric = 300,'cash out 300');
select t_assert((fn_cashbook(current_date,current_date)->>'bank_in')::numeric = 100,'bank in 100');
\echo ALL SQL TESTS PASSED
