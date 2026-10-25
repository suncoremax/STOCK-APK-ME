// Loads the real index.html in jsdom, wires fetch() to the real API handlers (on real Postgres) and clicks through every screen.
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const { makeDb } = require('./pgshim');
global.__BM_DB__ = makeDb({ host: '/tmp/pg', user: 'postgres', database: 'bmtest' });
process.env.SESSION_SECRET = 'ui-test';
const H = { auth: require('../api/auth'), data: require('../api/data'), ops: require('../api/ops'), reports: require('../api/reports'), system: require('../api/system') };
const errors = []; let checks = 0;
const ok = (c, m) => { checks++; if (!c) { console.error('✗', m); process.exitCode = 1; throw new Error(m); } };
const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(String(e.message || e))); vc.on('error', (e) => errors.push(String(e)));
const html = fs.readFileSync(__dirname + '/../src/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) {
  w.print = () => { w.__printed = (w.__printed || 0) + 1; };
  w.scrollTo = () => {};
  w.fetch = async (url, o) => {
    const u = new URL(url, 'http://localhost'); const name = u.pathname.replace('/api/', '');
    const q = {}; u.searchParams.forEach((v, k) => { q[k] = v; });
    const req = { method: (o && o.method) || 'GET', query: q, body: o && o.body ? JSON.parse(o.body) : {}, headers: { authorization: (o && o.headers && o.headers.Authorization) || '' } };
    let status = 200, json;
    const res = { setHeader() {}, status(c) { status = c; return this; }, json(j) { json = j; this.writableEnded = true; return this; }, end() { this.writableEnded = true; } };
    await H[name](req, res);
    return { status, json: async () => JSON.parse(JSON.stringify(json)) };
  };
} });
const w = dom.window, d = w.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, t = 4000) { const s = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch (e) {} if (Date.now() - s > t) throw new Error('timeout: ' + msg + ' | errors=' + errors.slice(-3).join(' ; ')); await sleep(30); } }
const $ = (s) => d.querySelector(s);
const setv = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const text = () => { const c = d.body.cloneNode(true); c.querySelectorAll('script,style,#print-area').forEach((n) => n.remove()); return c.textContent; };
async function nav(p, expect) { w.location.hash = '#' + p; await until(() => w.S.page === p.split(':')[0] && text().includes(expect) && !$('#main .spin'), p + ' → ' + expect); }

(async () => {
  // first-run setup
  await until(() => $('#lg'), 'setup screen');
  await until(() => text().includes('প্রথমবার সেটআপ'), 'setup text');
  setv($('#lb'), 'টেস্ট ট্রেডার্স'); setv($('#ln'), 'মালিক'); setv($('#lu'), 'owner'); setv($('#lp'), '123456'); click($('#lg'));
  await until(() => $('#main') && text().includes('নতুন বিক্রয়'), 'home after setup');
  await until(() => text().includes('আজকের বিক্রয়'), 'dashboard rendered');

  // master data through the UI
  await nav('suppliers', 'কোম্পানি'); w.supplierForm(); await until(() => $('#sn'), 'supplier form'); setv($('#sn'), 'ABC Co'); click($('#ssv')); await until(() => text().includes('ABC Co'), 'supplier saved');
  await nav('staff', 'কর্মী'); w.empForm(); await until(() => $('#en_'), 'emp form'); setv($('#en_'), 'করিম'); setv($('#ed_'), 'DSR'); setv($('#es_'), '12000'); click($('#esv_')); await until(() => text().includes('করিম'), 'employee saved');
  await nav('products', 'পণ্য'); w.productForm(); await until(() => $('#pn'), 'product form'); setv($('#pn'), 'সাবান'); setv($('#pcat'), 'কেয়ার'); setv($('#pcs'), '12'); setv($('#pcost'), '10'); setv($('#psell'), '15'); setv($('#plow'), '20'); setv($('#pst'), '100'); click($('#psv'));
  await until(() => text().includes('সাবান') && text().includes('স্টকের মূল্য'), 'product saved'); await until(() => text().includes('8 কেস 4 পিস'), 'stock cases+pcs: ' + $('#plist').textContent.slice(0,200));
  await nav('shops', 'দোকান'); w.shopForm(); await until(() => $('#fn'), 'shop form'); setv($('#fn'), 'রহিম স্টোর'); setv($('#far'), 'মিরপুর'); setv($('#fl'), '5000'); setv($('#fo'), '300'); click($('#fs_')); await until(() => text().includes('রহিম স্টোর') && text().includes('৳300'), 'shop saved with due');

  // purchase via UI
  await nav('purchase', 'কোম্পানি');
  await until(() => $('#psup_'), 'purchase form'); click($('#psup_')); await until(() => $('#pl .li'), 'supplier picker'); click($('#pl .li'));
  click($('#padd')); await until(() => $('#pl .li'), 'product picker'); click($('#pl .li'));
  await until(() => $('#pitems .item'), 'purchase item row'); const pin = $('#pitems [data-k=c]'); setv(pin, '2'); setv($('#pitems [data-k=cost]'), '11'); // 2 cases = 24 units @11 = 264
  await until(() => $('#psum').textContent.includes('264'), 'purchase total: ' + $('#psum').textContent); setv($('#ppaid'), '100'); click($('#psave'));
  await until(() => text().includes('কেনা সেভ হয়েছে') || $('#pbody .card .li'), 'purchase saved');

  // sale via UI
  await nav('sale', 'নতুন বিক্রয়');
  await until(() => $('#sshop'), 'sale form'); click($('#sshop')); await until(() => $('#pl .li'), 'shop picker'); click($('#pl .li[data-i]:not([data-i="__extra"])'));
  await until(() => $('#sshop').textContent.includes('রহিম'), 'shop selected');
  click($('#sadd')); await until(() => $('#pl .li'), 'prod picker'); click($('#pl .li'));
  await until(() => $('#sitems .item'), 'sale item'); setv($('#sitems [data-k=c]'), '1'); setv($('#sitems [data-k=u]'), '3'); // 15 pcs * 15 = 225
  await until(() => $('#ssum').textContent.includes('225'), 'sale total ' + $('#ssum').textContent);
  setv($('#sdisc'), '5'); await until(() => $('#ssum').textContent.includes('220'), 'discount applied'); setv($('#spaid'), '100');
  await until(() => $('#ssum').textContent.includes('120'), 'due shown');
  click($('#ssave')); await until(() => text().includes('বিক্রয় সম্পন্ন'), 'sale done modal'); await until(() => text().includes('S-000001'), 'invoice number: ' + (d.querySelector('.sheet')||{textContent:'no sheet'}).textContent.slice(0,120) + ' // ' + text().slice(Math.max(0,text().indexOf('বিক্রয় সম্পন্ন')-80), text().indexOf('বিক্রয় সম্পন্ন')+60));
  click(d.querySelector('[data-p]')); await sleep(300); ok(w.__printed === 1 && $('#print-area').textContent.includes('S-000001') && $('#print-area').textContent.includes('টেস্ট ট্রেডার্স'), 'invoice printed');
  click(d.querySelector('.sheet [data-n]'));

  // lists & detail
  await nav('sales', 'S-000001'); await until(() => $('#srows .li'), 'sales rows'); click($('#srows .li')); await until(() => text().includes('পণ্যের মোট'), 'invoice detail'); await until(() => text().includes('বাতিল'), 'void button for owner'); d.querySelector('.sheet [data-x]').click();

  // collect
  await nav('collect', 'রহিম স্টোর'); await until(() => $('#clist .li'), 'collect list'); await until(() => text().includes('৳420'), 'due = 300 + 120 = 420'); w.collectFor((await w.list('shops')).filter((s) => s.name.includes('রহিম'))[0].id);
  await until(() => $('#ca_'), 'collect modal'); ok($('#ca_').value === '420', 'prefilled full due'); setv($('#ca_'), '150'); click($('#cs_')); await until(() => text().includes('আদায় সেভ হয়েছে'), 'collection saved');
  const shopId = (await w.list('shops', true)).filter((s) => s.name.includes('রহিম'))[0].id;
  await w.shopBook(shopId); await until(() => text().includes('বাকি আদায়') && text().includes('খাতা প্রিন্ট'), 'shop book'); await until(() => text().includes('270'), 'balance 270 in book'); d.querySelector('.sheet [data-x]').click();

  // returns
  RET_OK: { await nav('returns', 'দোকান ফেরত'); await until(() => $('#rparty'), 'return form'); click($('#rparty')); await until(() => $('#pl .li'), 'return party'); click($('#pl .li')); click($('#radd')); await until(() => $('#pl .li'), 'ret prod'); click($('#pl .li')); await until(() => $('#ritems [data-k=u]'), 'ret row'); setv($('#ritems [data-k=u]'), '2'); click($('#rsave')); await until(() => text().includes('সেভ হয়েছে'), 'return saved'); }
  // tab switch to history
  click(d.querySelector('[data-t=hist]')); await until(() => text().includes('দোকান ফেরত —'), 'history lists return');

  // expenses
  await nav('expenses', 'নতুন খরচ'); await until(() => $('#ea'), 'expense form'); setv($('#ea'), '75'); setv($('#en'), 'তেল'); click($('#esv')); await until(() => text().includes('তেল') && text().includes('৳75'), 'expense listed');
  // cashbook
  await nav('cashbook', 'ক্যাশবুক'); await until(() => $('#dcc'), 'day close form'); await until(() => text().includes('হাতে') || text().includes('নগদ (হাতে)'), 'cashbook'); await until(() => text().includes('লেনদেনের তালিকা'), 'cash rows');
  setv($('#dcc'), '0'); click($('#dcs')); await until(() => text().includes('দিনশেষ') && (d.querySelector('.tt') || true), 'day close');
  // staff attendance + salary
  await nav('staff', 'কর্মী'); click(d.querySelector('.tab:nth-child(2)')); await until(() => text().includes('সবাই উপস্থিত'), 'attendance: ' + $('#main').textContent.slice(0,150)); click($('#aall')); await sleep(300);
  click(d.querySelectorAll('.tabs .tab')[2]); await until(() => text().includes('বেতন দিন'), 'salary tab');
  // reports — every tab
  await nav('reports', 'সারাংশ'); await until(() => text().includes('লাভ-ক্ষতির হিসাব'), 'summary');
  for (const t of ['product', 'shop', 'employee', 'category', 'area', 'dues', 'stock', 'pay']) { click(d.querySelector('.tabs [data-t=' + t + ']')); await until(() => !$('#rbd .spin') && !$('#rbd').textContent.includes('⚠️'), 'report ' + t + ' ' + ($('#rbd') && $('#rbd').textContent.slice(0, 80))); }
  // notes + settings
  await nav('notes', 'নোটিশ'); await nav('settings', 'আমার অ্যাকাউন্ট'); await until(() => $('#ulist .li'), 'users list'); await until(() => text().includes('ম্যানেজারের ক্ষমতা'), 'owner settings');
  click($('#au')); await until(() => $('#alog table'), 'audit table');
  // menu / logout
  w.toggleDrawer(true); ok($('#drawer').classList.contains('on'), 'drawer'); w.doLogout(); await until(() => $('#lg') && text().includes('লগইন'), 'logout → login screen');
  // manager restrictions in the UI
  const tok = await (async () => { const r = { method: 'POST', query: { action: 'user-save' }, body: { name: 'ম্যানেজার', username: 'mgr', role: 'manager', pin: '4321' }, headers: {} }; return null; })();
  setv($('#lu'), 'owner'); setv($('#lp'), '123456'); click($('#lg')); await until(() => $('#main'), 'relogin');
  const j = await w.api('auth', { action: 'user-save' }, { name: 'ম্যানেজার', username: 'mgr', role: 'manager', pin: '4321' }); ok(j.ok, 'manager created');
  w.doLogout(); await until(() => $('#lg')); setv($('#lu'), 'mgr'); setv($('#lp'), '4321'); click($('#lg')); await until(() => $('#main') && text().includes('নতুন বিক্রয়'), 'manager home');
  await sleep(150); ok(!text().includes('আজকের মোট লাভ'), 'manager has no profit tile');
  await nav('settings', 'আমার অ্যাকাউন্ট'); ok(!$('#setsave'), 'manager cannot see owner settings');
  await nav('products', 'পণ্য'); click($('#plist .li')); await until(() => text().includes('স্টকের ইতিহাস'), 'product detail'); await sleep(150); ok(!d.querySelector('.sheet [data-a=adj]') && !!d.querySelector('.sheet [data-a=edit]'), 'manager: no stock-adjust button'); await sleep(150); ok(![...d.querySelectorAll('.stat .l')].some((n) => n.textContent === 'ক্রয়মূল্য'), 'manager: no cost shown');
  ok(errors.length === 0, 'no JS errors: ' + errors.join(' | '));
  console.log('\n✔ UI smoke test passed (' + checks + ' checks, 0 JS errors)');
  await global.__BM_DB__.pool.end(); process.exit(0);
})().catch((e) => { console.error('UI TEST FAILED:', e.message, (e.stack||'').split('\n').filter(l=>l.includes('ui.test')).slice(0,2).join(' ')); console.error('JS errors:', errors.slice(0, 5)); process.exit(1); });
