/* ============ DU-TMS — Dhofar University Tender Management System ============ */
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const session = require('express-session');
const multer = require('multer');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('FATAL: MONGODB_URI env var is required.'); process.exit(1); }

let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  console.log('SMTP configured — email notifications enabled');
} else console.log('SMTP not configured — in-app notifications only');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true, limit: '30mb' }));
app.use(bodyParser.json({ limit: '30mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(session({ secret: 'du-tms-session-secret-2024', resave: false, saveUninitialized: false, cookie: { maxAge: 8 * 3600e3 } }));

const UP = path.join(__dirname, 'uploads');
fs.mkdirSync(path.join(UP, 'signatures'), { recursive: true });

const storage = multer.diskStorage({
  destination: (q, f, cb) => cb(null, UP),
  filename: (q, f, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(f.originalname).toLowerCase())
});
const upload = multer({
  storage, limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (q, f, cb) => { const ok = /\.(pdf|doc|docx|xls|xlsx|jpg|jpeg|png)$/i.test(f.originalname); cb(ok ? null : new Error('File type not allowed'), ok); }
});

/* ============================== MODELS ============================== */
const S = mongoose.Schema, O = S.Types.ObjectId, T = { timestamps: true };
const User = mongoose.model('User', new S({
  name: String, email: { type: String, unique: true }, password: String,
  role: { type: String, enum: ['super_admin','dvc','procurement_head','tender_handler','committee_member','finance_officer','vendor','webmaster'] },
  is_active: { type: Boolean, default: true }, phone: String,
  login_attempts: { type: Number, default: 0 }, locked_until: Date
}, T));
const Vendor = mongoose.model('Vendor', new S({
  user_id: { type: O, ref: 'User' }, company_name_en: String, company_name_ar: String,
  cr_number: { type: String, unique: true }, vat_number: String, address: String,
  categories: [String], status: { type: String, enum: ['pending','approved','blacklisted'], default: 'pending' },
  blacklist_reason: String, trade_license_path: String, cr_copy_path: String
}, T));
const Category = mongoose.model('Category', new S({ name: String, name_ar: String }, T));
const TENDER_STATUSES = ['draft','published','accepting_bids','bids_closed','under_evaluation','committee_decision','pending_dvc','dvc_approved','awarded','completed','archived','cancelled'];
const Tender = mongoose.model('Tender', new S({
  tender_number: { type: String, unique: true }, title: String, description: String, category: String,
  estimated_value_min: Number, estimated_value_max: Number, fee_amount: Number,
  fee_tier: { type: String, enum: ['small','medium','large','custom'] },
  submission_deadline: Date, opening_date: Date, contact_person: String, contact_details: String,
  status: { type: String, enum: TENDER_STATUSES, default: 'draft' },
  created_by: { type: O, ref: 'User' }, awarded_vendor_id: { type: O, ref: 'Vendor' },
  awarded_bid_id: { type: O, ref: 'Bid' }, cancelled_reason: String
}, T));
const TenderDocument = mongoose.model('TenderDocument', new S({
  tender_id: { type: O, ref: 'Tender' }, type: { type: String, enum: ['public','restricted'], default: 'public' },
  filename: String, original_name: String, filepath: String, version: { type: Number, default: 1 },
  uploaded_by: { type: O, ref: 'User' }
}, T));
const TenderParticipation = mongoose.model('TenderParticipation', new S({
  tender_id: { type: O, ref: 'Tender' }, vendor_id: { type: O, ref: 'Vendor' },
  status: { type: String, enum: ['interested','fee_paid','bid_submitted','under_evaluation','result_notified'], default: 'interested' },
  payment_ref: { type: String, unique: true }
}, T));
const FeePayment = mongoose.model('FeePayment', new S({
  participation_id: { type: O, ref: 'TenderParticipation' }, vendor_id: { type: O, ref: 'Vendor' },
  tender_id: { type: O, ref: 'Tender' }, amount: Number,
  payment_method: { type: String, enum: ['cash','bank_transfer'] }, reference_number: String,
  status: { type: String, enum: ['pending','confirmed','refunded'], default: 'pending' },
  receipt_path: String, confirmed_by: { type: O, ref: 'User' }, confirmed_at: Date
}, T));
const Bid = mongoose.model('Bid', new S({
  tender_id: { type: O, ref: 'Tender' }, vendor_id: { type: O, ref: 'Vendor' },
  bid_identifier: { type: String, unique: true }, encrypted_vendor: String,
  submitted_at: Date, envelope_count: Number, financial_amount: Number,
  status: { type: String, default: 'submitted' }, recorded_by: { type: O, ref: 'User' }
}, T));
const BidDocument = mongoose.model('BidDocument', new S({
  bid_id: { type: O, ref: 'Bid' }, type: { type: String, enum: ['technical','financial'] },
  filename: String, filepath: String, uploaded_by: { type: O, ref: 'User' }
}, T));
const EvaluationSession = mongoose.model('EvaluationSession', new S({
  tender_id: { type: O, ref: 'Tender' }, date: Date, time: String, venue: String,
  status: { type: String, enum: ['pending','in_progress','completed'], default: 'pending' },
  created_by: { type: O, ref: 'User' }, winning_bid_id: { type: O, ref: 'Bid' }, decision_reason: String
}, T));
const EvaluationSessionMember = mongoose.model('EvaluationSessionMember', new S({
  session_id: { type: O, ref: 'EvaluationSession' }, user_id: { type: O, ref: 'User' }, notified_at: Date
}, T));
const Evaluation = mongoose.model('Evaluation', new S({
  session_id: { type: O, ref: 'EvaluationSession' }, user_id: { type: O, ref: 'User' }, bid_id: { type: O, ref: 'Bid' },
  technical_scores: { understanding: Number, methodology: Number, deliverables: Number, timeline: Number, team: Number, experience: Number },
  technical_total: Number, financial_score: Number,
  recommendation: { type: String, enum: ['recommend','do_not_recommend'] },
  comments: String, signature_path: String, submitted_at: Date
}, T));
const Approval = mongoose.model('Approval', new S({
  tender_id: { type: O, ref: 'Tender' }, approver_id: { type: O, ref: 'User' },
  status: { type: String, enum: ['pending','approved','rejected','requested_info'], default: 'pending' },
  comments: String, decided_at: Date
}, T));
const Notification = mongoose.model('Notification', new S({
  user_id: { type: O, ref: 'User' }, type: String,
  channel: { type: String, enum: ['email','in_app','both'], default: 'both' },
  subject: String, body: String, is_read: { type: Boolean, default: false }, sent_at: Date
}, T));
const AuditLog = mongoose.model('AuditLog', new S({
  user_id: { type: O, ref: 'User' }, user_role: String, entity_type: String, entity_id: String,
  action: String, old_values: S.Types.Mixed, new_values: S.Types.Mixed, ip_address: String
}, T));
const Setting = mongoose.model('Setting', new S({ key: { type: String, unique: true }, value: S.Types.Mixed }, T));

/* ============================== HELPERS ============================== */
const ENC_KEY = crypto.createHash('sha256').update('du-tms-vendor-mapping-secret').digest();
function generateBidIdentifier() { return 'BID-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function encryptVendorMapping(id) {
  const iv = crypto.randomBytes(16), c = crypto.createCipheriv('aes-256-cbc', ENC_KEY, iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(String(id), 'utf8'), c.final()]).toString('hex');
}
function decryptVendorMapping(enc) {
  try { const [ivh, data] = enc.split(':'); const d = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, Buffer.from(ivh, 'hex'));
    return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8'); } catch (e) { return null; }
}
function getFeeTier(min, max) {
  const v = Number(max || min || 0);
  if (v < 20000) return { tier: 'small', amount: 30 };
  if (v <= 100000) return { tier: 'medium', amount: 50 };
  return { tier: 'large', amount: 100 };
}
async function generateTenderNumber() {
  const y = new Date().getFullYear();
  const c = await Tender.countDocuments({ tender_number: new RegExp('^DU/TND/' + y + '/') });
  return 'DU/TND/' + y + '/' + String(c + 1).padStart(3, '0');
}
async function auditLog(userId, role, entity, entityId, action, oldV, newV, ip) {
  try { await AuditLog.create({ user_id: userId, user_role: role, entity_type: entity, entity_id: String(entityId || ''), action, old_values: oldV, new_values: newV, ip_address: ip || '' }); } catch (e) { console.error('audit:', e.message); }
}
async function sendNotification(userId, type, subject, body, channel = 'both') {
  try {
    await Notification.create({ user_id: userId, type, channel, subject, body, sent_at: new Date() });
    if (mailer && (channel === 'email' || channel === 'both')) {
      const u = await User.findById(userId);
      if (u && u.email) mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: u.email, subject, text: body }).catch(e => console.error('mail:', e.message));
    }
  } catch (e) { console.error('notify:', e.message); }
}
const TRANSITIONS = {
  draft: ['published'], published: ['accepting_bids', 'cancelled'], accepting_bids: ['bids_closed', 'cancelled'],
  bids_closed: ['under_evaluation', 'cancelled'], under_evaluation: ['committee_decision'],
  committee_decision: ['pending_dvc'], pending_dvc: ['dvc_approved', 'bids_closed'],
  dvc_approved: ['awarded'], awarded: ['completed'], completed: ['archived']
};
function nextValidStatus(current, target) { return (TRANSITIONS[current] || []).includes(target) ? target : null; }
function saveSignature(dataUrl, userId) {
  if (!dataUrl || !dataUrl.startsWith('data:image')) return null;
  const fp = 'uploads/signatures/sig-' + userId + '-' + Date.now() + '.png';
  fs.writeFileSync(path.join(__dirname, fp), Buffer.from(dataUrl.split(',')[1], 'base64'));
  return fp;
}
async function computeResults(sessionDoc) {
  const bids = await Bid.find({ tender_id: sessionDoc.tender_id });
  const evals = await Evaluation.find({ session_id: sessionDoc._id }).populate('user_id', 'name');
  const prices = bids.map(b => b.financial_amount);
  const max = Math.max(...prices), min = Math.min(...prices);
  return bids.map(b => {
    const be = evals.filter(e => String(e.bid_id) === String(b._id));
    const avgTech = be.length ? be.reduce((s, e) => s + (e.technical_total || 0), 0) / be.length : 0;
    const normFin = max === min ? 10 : ((max - b.financial_amount) / (max - min)) * 10;
    return { bid_id: b._id, bid_identifier: b.bid_identifier, financial_amount: b.financial_amount,
      avgTech: +avgTech.toFixed(2), normFin: +normFin.toFixed(2),
      final: +((avgTech * 0.4) + (normFin * 0.6)).toFixed(2), evals: be };
  }).sort((a, b) => b.final - a.final);
}

/* ============================== SEED ============================== */
async function seed() {
  if (await Category.countDocuments() === 0) {
    await Category.insertMany([
      { name: 'Information Technology', name_ar: 'تقنية المعلومات' }, { name: 'Construction & Civil Works', name_ar: 'الإنشاءات والأعمال المدنية' },
      { name: 'Laboratory Equipment', name_ar: 'معدات المختبرات' }, { name: 'Furniture', name_ar: 'الأثاث' },
      { name: 'Cleaning Services', name_ar: 'خدمات النظافة' }, { name: 'Security Services', name_ar: 'خدمات الأمن' },
      { name: 'Catering Services', name_ar: 'خدمات التموين' }, { name: 'Printing & Publishing', name_ar: 'الطباعة والنشر' },
      { name: 'Transportation', name_ar: 'النقل' }, { name: 'Consultancy Services', name_ar: 'الخدمات الاستشارية' },
      { name: 'Maintenance & Facilities', name_ar: 'الصيانة والمرافق' }
    ]);
    console.log('Seeded 11 categories');
  }
  if (!await User.findOne({ email: 'admin@du.edu.om' })) {
    await User.create({ name: 'System Administrator', email: 'admin@du.edu.om', password: 'admin123', role: 'super_admin', is_active: true });
    console.log('Seeded super_admin');
  }
  const defaults = { sla_days: 7, fee_small: 30, fee_medium: 50, fee_large: 100, system_name: 'DU-TMS' };
  for (const [k, v] of Object.entries(defaults))
    if (!await Setting.findOne({ key: k })) await Setting.create({ key: k, value: v });
}

/* ============================== MIDDLEWARE ============================== */
function requireAuth(req, res, next) { if (!req.session.user) return res.redirect('/login?error=Please+sign+in'); next(); }
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) return res.redirect('/app?page=dashboard&msg=Access+denied');
    next();
  };
}

/* ============================== PUBLIC ROUTES ============================== */
app.get('/', (req, res) => res.redirect('/login'));

app.get('/public-tenders', async (req, res) => {
  const tenders = await Tender.find({ status: { $in: ['published', 'accepting_bids'] } }).sort({ createdAt: -1 });
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Public Tenders — DU</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>body{font-family:Inter,sans-serif;background:#F1F5F9}</style></head><body>
  <nav class="navbar" style="background:#0F172A"><div class="container"><span class="navbar-brand text-white fw-bold">DU-TMS — Public Tenders</span>
  <a href="/login" class="btn btn-sm btn-outline-light">Login</a></div></nav>
  <div class="container py-4"><div class="card shadow-sm" style="border-radius:16px"><div class="card-body">
  <h5 class="fw-bold mb-3">Open Tenders (${tenders.length})</h5>
  <table class="table table-hover"><thead><tr><th>Tender #</th><th>Title</th><th>Category</th><th>Fee (OMR)</th><th>Deadline</th><th>Status</th></tr></thead><tbody>
  ${tenders.map(t => `<tr><td>${t.tender_number}</td><td>${t.title}</td><td>${t.category}</td><td>${t.fee_amount}</td>
  <td>${t.submission_deadline ? new Date(t.submission_deadline).toLocaleDateString() : '—'}</td>
  <td><span class="badge bg-${t.status === 'published' ? 'primary' : 'info'}">${t.status.replace('_', ' ')}</span></td></tr>`).join('')}
  </tbody></table><a href="/vendor-register" class="btn btn-primary">Register as Vendor to Participate</a></div></div></div></body></html>`);
});

app.get('/vendor-register', async (req, res) => {
  const cats = await Category.find();
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Vendor Registration — DU</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>body{font-family:Inter,sans-serif;background:linear-gradient(135deg,#0F2027,#203A43,#2C5364);min-height:100vh;padding:40px 0}</style></head><body>
  <div class="container" style="max-width:640px"><div class="card shadow-lg" style="border-radius:20px"><div class="card-body p-4">
  <h4 class="fw-bold">Vendor Registration</h4><p class="text-muted">Dhofar University — Procurement Portal</p>
  <form method="POST" action="/vendor-register">
  <div class="row g-3">
  <div class="col-md-6"><label class="form-label">Contact Name</label><input name="name" class="form-control" required></div>
  <div class="col-md-6"><label class="form-label">Email</label><input type="email" name="email" class="form-control" required></div>
  <div class="col-md-6"><label class="form-label">Phone</label><input name="phone" class="form-control" required></div>
  <div class="col-md-6"><label class="form-label">Password</label><input type="password" name="password" class="form-control" required></div>
  <div class="col-md-6"><label class="form-label">Company Name (EN)</label><input name="company_name_en" class="form-control" required></div>
  <div class="col-md-6"><label class="form-label">Company Name (AR)</label><input name="company_name_ar" class="form-control"></div>
  <div class="col-md-6"><label class="form-label">CR Number</label><input name="cr_number" class="form-control" required></div>
  <div class="col-md-6"><label class="form-label">VAT Number</label><input name="vat_number" class="form-control"></div>
  <div class="col-12"><label class="form-label">Address</label><input name="address" class="form-control"></div>
  <div class="col-12"><label class="form-label">Categories</label><div class="row">
  ${cats.map(c => `<div class="col-md-6"><label class="form-check"><input class="form-check-input" type="checkbox" name="categories" value="${c.name}"> ${c.name}</label></div>`).join('')}
  </div></div></div>
  <button class="btn btn-primary w-100 mt-4">Submit Registration</button>
  <p class="text-center mt-3 mb-0"><a href="/login">Back to Login</a></p></form></div></div></div></body></html>`);
});

app.post('/vendor-register', async (req, res) => {
  try {
    const b = req.body;
    if (await User.findOne({ email: b.email })) return res.redirect('/login?error=Email+already+registered');
    const u = await User.create({ name: b.name, email: b.email, phone: b.phone, password: b.password, role: 'vendor', is_active: false });
    await Vendor.create({ user_id: u._id, company_name_en: b.company_name_en, company_name_ar: b.company_name_ar,
      cr_number: b.cr_number, vat_number: b.vat_number, address: b.address,
      categories: [].concat(b.categories || []), status: 'pending' });
    await auditLog(u._id, 'vendor', 'Vendor', u._id, 'register', null, { company: b.company_name_en }, req.ip);
    res.redirect('/login?msg=Registration+submitted.+Await+approval.');
  } catch (e) { res.redirect('/login?error=' + encodeURIComponent('Registration failed: ' + e.message)); }
});

app.get('/login', (req, res) => res.render('login', { error: req.query.error || null, msg: req.query.msg || null }));

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const u = await User.findOne({ email });
  if (!u) return res.redirect('/login?error=Invalid+credentials');
  if (u.locked_until && u.locked_until > new Date()) return res.redirect('/login?error=Account+locked.+Try+again+in+15+minutes.');
  if (!u.is_active) return res.redirect('/login?error=Account+inactive+or+pending+approval');
  if (u.password !== password) {
    u.login_attempts = (u.login_attempts || 0) + 1;
    if (u.login_attempts >= 5) { u.locked_until = new Date(Date.now() + 15 * 60e3); u.login_attempts = 0; }
    await u.save();
    return res.redirect('/login?error=Invalid+credentials');
  }
  u.login_attempts = 0; u.locked_until = null; await u.save();
  let vendorId = null;
  if (u.role === 'vendor') { const v = await Vendor.findOne({ user_id: u._id }); vendorId = v ? v._id : null; }
  req.session.user = { id: u._id, name: u.name, email: u.email, role: u.role, vendorId };
  await auditLog(u._id, u.role, 'User', u._id, 'login', null, null, req.ip);
  res.redirect('/app?page=dashboard');
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login?msg=Signed+out')));

/* ============================== FILE ROUTES ============================== */
app.post('/app/upload-document', requireAuth, upload.single('file'), async (req, res) => {
  const v = await TenderDocument.countDocuments({ tender_id: req.body.tender_id });
  await TenderDocument.create({ tender_id: req.body.tender_id, type: req.body.type || 'public',
    filename: req.file.filename, original_name: req.file.originalname,
    filepath: 'uploads/' + req.file.filename, version: v + 1, uploaded_by: req.session.user.id });
  await auditLog(req.session.user.id, req.session.user.role, 'TenderDocument', req.body.tender_id, 'upload', null, { file: req.file.originalname }, req.ip);
  res.redirect('/app?page=tender_detail&id=' + req.body.tender_id + '&msg=Document+uploaded');
});
app.post('/app/upload-bid-document', requireAuth, upload.single('file'), async (req, res) => {
  await BidDocument.create({ bid_id: req.body.bid_id, type: req.body.doc_type,
    filename: req.file.originalname, filepath: 'uploads/' + req.file.filename, uploaded_by: req.session.user.id });
  res.redirect('/app?page=view_bid_docs&id=' + req.body.tender_id + '&msg=Bid+document+uploaded');
});
app.post('/app/save-signature', requireAuth, (req, res) => {
  const p = saveSignature(req.body.signature_data, req.session.user.id);
  res.json({ ok: !!p, path: p });
});
app.get('/app/download/:type/:id', requireAuth, async (req, res) => {
  let fp = null, name = 'file';
  if (req.params.type === 'tender-doc') { const d = await TenderDocument.findById(req.params.id); if (d) { fp = d.filepath; name = d.original_name; } }
  else if (req.params.type === 'receipt') { const p = await FeePayment.findById(req.params.id); if (p) { fp = p.receipt_path; name = 'receipt.pdf'; } }
  else if (req.params.type === 'bid-doc') { const d = await BidDocument.findById(req.params.id); if (d) { fp = d.filepath; name = d.filename; } }
  if (!fp || !fs.existsSync(path.join(__dirname, fp))) return res.status(404).send('File not found');
  res.download(path.join(__dirname, fp), name);
});
app.get('/app/notifications/read/:id', requireAuth, async (req, res) => {
  await Notification.updateOne({ _id: req.params.id, user_id: req.session.user.id }, { is_read: true });
  res.redirect('/app?page=notifications');
});

/* ============================== APP HANDLER ============================== */
async function appHandler(req, res) {
  try {
    const su = req.session.user;
    const user = await User.findById(su.id);
    if (!user || !user.is_active) return req.session.destroy(() => res.redirect('/login?error=Session+expired'));
    const role = user.role;
    let page = req.query.page || 'dashboard';
    let msg = req.query.msg || null;
    const R = q => res.redirect('/app?' + q);

    /* ---- POST actions ---- */
    if (req.method === 'POST') {
      const b = req.body, a = b.action;
      switch (a) {
        case 'create_tender': {
          if (!b.title || !b.category || !b.submission_deadline) return R('page=create_tender&msg=Missing+required+fields');
          const num = await generateTenderNumber();
          const ft = getFeeTier(+b.estimated_value_min, +b.estimated_value_max);
          const t = await Tender.create({ tender_number: num, title: b.title, description: b.description, category: b.category,
            estimated_value_min: +b.estimated_value_min || 0, estimated_value_max: +b.estimated_value_max || 0,
            fee_amount: ft.amount, fee_tier: ft.tier, submission_deadline: new Date(b.submission_deadline),
            opening_date: b.opening_date ? new Date(b.opening_date) : null, contact_person: b.contact_person,
            contact_details: b.contact_details, status: 'draft', created_by: user._id });
          await auditLog(user._id, role, 'Tender', t._id, 'create', null, { tender_number: num }, req.ip);
          return R('page=tender_detail&id=' + t._id + '&msg=Tender+created+as+draft');
        }
        case 'publish_tender': {
          const t = await Tender.findById(b.tender_id);
          if (!t || !nextValidStatus(t.status, 'published')) return R('page=tender_detail&id=' + b.tender_id + '&msg=Invalid+status+transition');
          t.status = 'published'; await t.save();
          t.status = nextValidStatus('published', 'accepting_bids'); await t.save();
          const vendors = await Vendor.find({ status: 'approved', categories: t.category });
          for (const v of vendors) {
            await TenderParticipation.create({ tender_id: t._id, vendor_id: v._id, status: 'interested',
              payment_ref: 'PAY-' + crypto.randomBytes(4).toString('hex').toUpperCase() });
            await sendNotification(v.user_id, 'tender_published', 'New Tender: ' + t.title,
              `Tender ${t.tender_number} in your category "${t.category}" is now accepting bids. Fee: OMR ${t.fee_amount}.`);
          }
          await auditLog(user._id, role, 'Tender', t._id, 'publish', { status: 'draft' }, { status: t.status }, req.ip);
          return R('page=tender_detail&id=' + t._id + '&msg=Tender+published+—+' + vendors.length + '+vendors+notified');
        }
        case 'update_tender': {
          const t = await Tender.findById(b.tender_id);
          if (!t) return R('page=manage_tenders&msg=Not+found');
          const old = { title: t.title, description: t.description };
          Object.assign(t, { title: b.title || t.title, description: b.description || t.description,
            contact_person: b.contact_person || t.contact_person, contact_details: b.contact_details || t.contact_details });
          await t.save();
          await auditLog(user._id, role, 'Tender', t._id, 'update', old, { title: t.title }, req.ip);
          return R('page=tender_detail&id=' + t._id + '&msg=Tender+updated');
        }
        case 'extend_deadline': {
          const t = await Tender.findById(b.tender_id);
          if (!t || t.status !== 'accepting_bids') return R('page=tender_detail&id=' + b.tender_id + '&msg=Only+accepting_bids+tenders+can+be+extended');
          const old = t.submission_deadline;
          t.submission_deadline = new Date(b.new_deadline); await t.save();
          const parts = await TenderParticipation.find({ tender_id: t._id }).populate('vendor_id');
          for (const p of parts) if (p.vendor_id) await sendNotification(p.vendor_id.user_id, 'deadline_extended', 'Deadline Extended: ' + t.title, `New deadline: ${t.submission_deadline.toLocaleString()}`);
          await auditLog(user._id, role, 'Tender', t._id, 'extend_deadline', { deadline: old }, { deadline: t.submission_deadline }, req.ip);
          return R('page=tender_detail&id=' + t._id + '&msg=Deadline+extended');
        }
        case 'cancel_tender': {
          const t = await Tender.findById(b.tender_id);
          if (!t || !nextValidStatus(t.status, 'cancelled')) return R('page=tender_detail&id=' + b.tender_id + '&msg=Cannot+cancel+at+this+stage');
          const old = t.status;
          t.status = 'cancelled'; t.cancelled_reason = b.reason || 'Cancelled'; await t.save();
          await FeePayment.updateMany({ tender_id: t._id, status: 'confirmed' }, { status: 'refunded' });
          const parts = await TenderParticipation.find({ tender_id: t._id }).populate('vendor_id');
          for (const p of parts) if (p.vendor_id) await sendNotification(p.vendor_id.user_id, 'tender_cancelled', 'Tender Cancelled: ' + t.title, `Reason: ${t.cancelled_reason}. Paid fees will be refunded.`);
          await auditLog(user._id, role, 'Tender', t._id, 'cancel', { status: old }, { status: 'cancelled' }, req.ip);
          return R('page=manage_tenders&msg=Tender+cancelled');
        }
        case 'approve_vendor': {
          const v = await Vendor.findById(b.vendor_id);
          if (!v) return R('page=pending_vendors&msg=Not+found');
          v.status = 'approved'; await v.save();
          await User.updateOne({ _id: v.user_id }, { is_active: true });
          await sendNotification(v.user_id, 'vendor_approved', 'Registration Approved', 'Your vendor account is approved. You can now log in and participate in tenders.');
          await auditLog(user._id, role, 'Vendor', v._id, 'approve', { status: 'pending' }, { status: 'approved' }, req.ip);
          return R('page=pending_vendors&msg=Vendor+approved');
        }
        case 'reject_vendor': {
          const v = await Vendor.findById(b.vendor_id);
          if (!v) return R('page=pending_vendors&msg=Not+found');
          v.status = 'blacklisted'; v.blacklist_reason = b.reason || 'Registration rejected'; await v.save();
          await sendNotification(v.user_id, 'vendor_rejected', 'Registration Rejected', 'Your vendor registration was not approved. Reason: ' + v.blacklist_reason);
          await auditLog(user._id, role, 'Vendor', v._id, 'reject', null, { reason: v.blacklist_reason }, req.ip);
          return R('page=pending_vendors&msg=Vendor+rejected');
        }
        case 'blacklist_vendor': {
          const v = await Vendor.findById(b.vendor_id);
          if (!v) return R('page=manage_vendors&msg=Not+found');
          const old = v.status;
          v.status = 'blacklisted'; v.blacklist_reason = b.reason || 'Blacklisted'; await v.save();
          await auditLog(user._id, role, 'Vendor', v._id, 'blacklist', { status: old }, { status: 'blacklisted', reason: v.blacklist_reason }, req.ip);
          return R('page=manage_vendors&msg=Vendor+blacklisted');
        }
        case 'confirm_fee': {
          const p = await TenderParticipation.findOne({ _id: b.participation_id, status: 'interested' }).populate('tender_id vendor_id');
          if (!p) return R('page=pending_fees&msg=Participation+not+found+or+already+paid');
          await FeePayment.create({ participation_id: p._id, vendor_id: p.vendor_id._id, tender_id: p.tender_id._id,
            amount: p.tender_id.fee_amount, payment_method: b.payment_method, reference_number: b.reference_number,
            status: 'confirmed', confirmed_by: user._id, confirmed_at: new Date() });
          p.status = 'fee_paid'; await p.save();
          await sendNotification(p.vendor_id.user_id, 'fee_confirmed', 'Fee Confirmed: ' + p.tender_id.title, `Your fee of OMR ${p.tender_id.fee_amount} is confirmed (Ref: ${b.reference_number}). You may now submit your bid.`);
          await auditLog(user._id, role, 'FeePayment', p._id, 'confirm_fee', null, { amount: p.tender_id.fee_amount }, req.ip);
          return R('page=pending_fees&msg=Fee+confirmed');
        }
        case 'refund_fee': {
          const fp = await FeePayment.findById(b.payment_id);
          if (!fp) return R('page=fee_history&msg=Not+found');
          fp.status = 'refunded'; await fp.save();
          await TenderParticipation.updateOne({ _id: fp.participation_id }, { status: 'interested' });
          await auditLog(user._id, role, 'FeePayment', fp._id, 'refund', { status: 'confirmed' }, { status: 'refunded' }, req.ip);
          return R('page=fee_history&msg=Fee+refunded');
        }
        case 'record_bid': {
          const t = await Tender.findById(b.tender_id);
          if (!t || t.status !== 'accepting_bids') return R('page=record_bid&id=' + b.tender_id + '&msg=Tender+not+accepting+bids');
          const count = await Bid.countDocuments({ tender_id: t._id });
          if (count >= 5) return R('page=record_bid&id=' + t._id + '&msg=Maximum+5+bids+reached');
          const p = await TenderParticipation.findOne({ _id: b.participation_id, status: 'fee_paid' });
          if (!p) return R('page=record_bid&id=' + t._id + '&msg=Invalid+participation+(fee+not+paid+or+bid+exists)');
          const bid = await Bid.create({ tender_id: t._id, vendor_id: p.vendor_id,
            bid_identifier: generateBidIdentifier(), encrypted_vendor: encryptVendorMapping(p.vendor_id),
            submitted_at: new Date(), envelope_count: +b.envelope_count || 2,
            financial_amount: +b.financial_amount, recorded_by: user._id });
          p.status = 'bid_submitted'; await p.save();
          const newCount = count + 1;
          if (newCount >= 5) { t.status = nextValidStatus(t.status, 'bids_closed') || t.status; await t.save(); }
          await auditLog(user._id, role, 'Bid', bid._id, 'record_bid', null, { bid_identifier: bid.bid_identifier }, req.ip);
          return R('page=record_bid&id=' + t._id + '&msg=Bid+' + bid.bid_identifier + '+recorded+(' + newCount + '/5)');
        }
        case 'create_evaluation_session': {
          const t = await Tender.findById(b.tender_id);
          if (!t || t.status !== 'bids_closed') return R('page=tender_detail&id=' + b.tender_id + '&msg=Tender+must+be+bids_closed');
          const count = await Bid.countDocuments({ tender_id: t._id });
          if (count < 3) return R('page=tender_detail&id=' + t._id + '&msg=Minimum+3+bids+required+for+evaluation');
          const members = [].concat(b.member_ids || []);
          if (members.length < 1) return R('page=create_evaluation&id=' + t._id + '&msg=Select+committee+members');
          const ses = await EvaluationSession.create({ tender_id: t._id, date: new Date(b.date), time: b.time, venue: b.venue, status: 'in_progress', created_by: user._id });
          for (const m of members) {
            await EvaluationSessionMember.create({ session_id: ses._id, user_id: m, notified_at: new Date() });
            await sendNotification(m, 'evaluation_assigned', 'Evaluation Session: ' + t.title, `You are assigned to evaluate tender ${t.tender_number} on ${b.date} at ${b.time}, ${b.venue}.`);
          }
          t.status = nextValidStatus(t.status, 'under_evaluation'); await t.save();
          await auditLog(user._id, role, 'EvaluationSession', ses._id, 'create_session', null, { members: members.length }, req.ip);
          return R('page=tender_detail&id=' + t._id + '&msg=Evaluation+session+created');
        }
        case 'submit_evaluation': {
          const ses = await EvaluationSession.findById(b.session_id);
          if (!ses) return R('page=dashboard&msg=Session+not+found');
          const existing = await Evaluation.findOne({ session_id: ses._id, user_id: user._id });
          if (existing) return R('page=evaluate&id=' + ses._id + '&msg=You+already+submitted');
          const sigPath = saveSignature(b.signature_data, user._id);
          const bids = await Bid.find({ tender_id: ses.tender_id });
          for (const bid of bids) {
            const k = String(bid._id);
            const sc = {
              understanding: +b['score_' + k + '_understanding'], methodology: +b['score_' + k + '_methodology'],
              deliverables: +b['score_' + k + '_deliverables'], timeline: +b['score_' + k + '_timeline'],
              team: +b['score_' + k + '_team'], experience: +b['score_' + k + '_experience']
            };
            const vals = Object.values(sc).map(x => Math.min(10, Math.max(1, x || 1)));
            const total = +(vals.reduce((s, x) => s + x, 0) / 6).toFixed(2);
            await Evaluation.create({ session_id: ses._id, user_id: user._id, bid_id: bid._id,
              technical_scores: sc, technical_total: total,
              recommendation: b['rec_' + k] === 'recommend' ? 'recommend' : 'do_not_recommend',
              comments: b['comments_' + k] || '', signature_path: sigPath, submitted_at: new Date() });
          }
          const members = await EvaluationSessionMember.find({ session_id: ses._id });
          const done = await Evaluation.distinct('user_id', { session_id: ses._id });
          if (done.length >= members.length) {
            ses.status = 'completed'; await ses.save();
            const t = await Tender.findById(ses.tender_id);
            await sendNotification(t.created_by, 'evaluation_complete', 'Evaluations Complete: ' + t.title, 'All committee members have submitted. Please review results and select a winner.');
          }
          await auditLog(user._id, role, 'Evaluation', ses._id, 'submit_evaluation', null, { bids: bids.length }, req.ip);
          return R('page=evaluate&id=' + ses._id + '&msg=Evaluation+submitted');
        }
        case 'select_winner': {
          const ses = await EvaluationSession.findOne({ _id: b.session_id, status: 'completed' });
          if (!ses) return R('page=dashboard&msg=Session+not+completed');
          ses.winning_bid_id = b.winning_bid_id; ses.decision_reason = b.decision_reason; await ses.save();
          const t = await Tender.findById(ses.tender_id);
          t.status = nextValidStatus(t.status, 'committee_decision'); await t.save();
          t.status = nextValidStatus(t.status, 'pending_dvc'); await t.save();
          const dvc = await User.findOne({ role: 'dvc', is_active: true });
          if (dvc) {
            await Approval.create({ tender_id: t._id, approver_id: dvc._id, status: 'pending' });
            await sendNotification(dvc._id, 'approval_required', 'DVC Approval Required: ' + t.title, `Committee decision for ${t.tender_number} awaits your approval.`);
          }
          await auditLog(user._id, role, 'Tender', t._id, 'select_winner', null, { winning_bid: String(b.winning_bid_id) }, req.ip);
          return R('page=tender_detail&id=' + t._id + '&msg=Winner+selected+—+sent+to+DVC');
        }
        case 'dvc_approve': {
          const ap = await Approval.findById(b.approval_id).populate('tender_id');
          if (!ap || ap.status !== 'pending') return R('page=approvals&msg=Approval+not+found');
          ap.status = 'approved'; ap.comments = b.comments || ''; ap.decided_at = new Date(); await ap.save();
          const t = await Tender.findById(ap.tender_id._id);
          t.status = nextValidStatus(t.status, 'dvc_approved'); await t.save();
          const ses = await EvaluationSession.findOne({ tender_id: t._id, status: 'completed' }).sort({ createdAt: -1 });
          const winBid = await Bid.findById(ses.winning_bid_id);
          const vendorId = decryptVendorMapping(winBid.encrypted_vendor) || String(winBid.vendor_id);
          t.awarded_vendor_id = vendorId; t.awarded_bid_id = winBid._id;
          t.status = nextValidStatus(t.status, 'awarded'); await t.save();
          const winner = await Vendor.findById(vendorId);
          if (winner) await sendNotification(winner.user_id, 'award_letter', 'AWARD LETTER — ' + t.title, `Congratulations! ${winner.company_name_en} has been awarded tender ${t.tender_number} at OMR ${winBid.financial_amount}.`);
          const others = await TenderParticipation.find({ tender_id: t._id, vendor_id: { $ne: vendorId }, status: 'bid_submitted' }).populate('vendor_id');
          for (const p of others) { if (p.vendor_id) await sendNotification(p.vendor_id.user_id, 'non_award', 'Tender Result — ' + t.title, `Thank you for participating in ${t.tender_number}. Your bid was not selected.`); p.status = 'result_notified'; await p.save(); }
          await auditLog(user._id, role, 'Approval', ap._id, 'dvc_approve', null, { tender: t.tender_number }, req.ip);
          return R('page=approvals&msg=Approved+—+award+letters+sent');
        }
        case 'dvc_reject': {
          if (!b.comments) return R('page=approval_detail&id=' + b.approval_id + '&msg=Rejection+comments+are+mandatory');
          const ap = await Approval.findById(b.approval_id);
          if (!ap || ap.status !== 'pending') return R('page=approvals&msg=Not+found');
          ap.status = 'rejected'; ap.comments = b.comments; ap.decided_at = new Date(); await ap.save();
          const t = await Tender.findById(ap.tender_id);
          t.status = nextValidStatus(t.status, 'bids_closed') || t.status; await t.save();
          await sendNotification(t.created_by, 'dvc_rejected', 'DVC Rejected: ' + t.title, 'Reason: ' + b.comments);
          await auditLog(user._id, role, 'Approval', ap._id, 'dvc_reject', null, { comments: b.comments }, req.ip);
          return R('page=approvals&msg=Rejected+—+returned+to+handler');
        }
        case 'dvc_request_info': {
          const ap = await Approval.findById(b.approval_id);
          if (!ap) return R('page=approvals&msg=Not+found');
          ap.status = 'requested_info'; ap.comments = b.comments || 'More information requested'; ap.decided_at = new Date(); await ap.save();
          const t = await Tender.findById(ap.tender_id);
          await sendNotification(t.created_by, 'info_requested', 'DVC Requests Info: ' + t.title, ap.comments);
          return R('page=approvals&msg=Information+requested');
        }
        case 'express_interest': {
          if (role !== 'vendor') return R('page=dashboard&msg=Vendors+only');
          const v = await Vendor.findById(su.vendorId);
          if (!v || v.status === 'blacklisted') return R('page=manage_tenders&msg=Your+account+cannot+participate');
          let p = await TenderParticipation.findOne({ tender_id: b.tender_id, vendor_id: v._id });
          if (!p) p = await TenderParticipation.create({ tender_id: b.tender_id, vendor_id: v._id, status: 'interested', payment_ref: 'PAY-' + crypto.randomBytes(4).toString('hex').toUpperCase() });
          return R('page=manage_tenders&msg=Interest+registered.+Payment+ref:+' + p.payment_ref);
        }
        case 'update_profile': {
          const v = await Vendor.findById(su.vendorId);
          if (v) { Object.assign(v, { company_name_en: b.company_name_en || v.company_name_en, company_name_ar: b.company_name_ar || v.company_name_ar, vat_number: b.vat_number || v.vat_number, address: b.address || v.address, categories: [].concat(b.categories || v.categories) }); await v.save(); }
          await User.updateOne({ _id: user._id }, { name: b.name || user.name, phone: b.phone || user.phone });
          return R('page=my_profile&msg=Profile+updated');
        }
        case 'add_user': {
          if (await User.findOne({ email: b.email })) return R('page=manage_users&msg=Email+exists');
          const nu = await User.create({ name: b.name, email: b.email, password: b.password, role: b.role, phone: b.phone, is_active: true });
          await auditLog(user._id, role, 'User', nu._id, 'add_user', null, { email: b.email, role: b.role }, req.ip);
          return R('page=manage_users&msg=User+created');
        }
        case 'update_setting': {
          await Setting.updateOne({ key: b.key }, { value: b.value }, { upsert: true });
          await auditLog(user._id, role, 'Setting', b.key, 'update_setting', null, { value: b.value }, req.ip);
          return R('page=settings&msg=Setting+saved');
        }
        case 'send_broadcast': {
          const targets = b.audience === 'all' ? await User.find({ is_active: true }) : await User.find({ role: b.audience, is_active: true });
          for (const u2 of targets) await sendNotification(u2._id, 'broadcast', b.subject, b.message);
          return R('page=broadcast_notification&msg=Broadcast+sent+to+' + targets.length + '+users');
        }
        default: return R('page=dashboard&msg=Unknown+action');
      }
    }

    /* ---- GET: auto-status ---- */
    const now = new Date();
    const expiring = await Tender.find({ status: 'accepting_bids', submission_deadline: { $lt: now } });
    for (const t of expiring) {
      const c = await Bid.countDocuments({ tender_id: t._id });
      if (c >= 3) { t.status = 'bids_closed'; await t.save(); await auditLog(null, 'system', 'Tender', t._id, 'auto_close', null, { status: 'bids_closed' }, ''); }
    }

    /* ---- GET: delete handling ---- */
    if (req.query.delete && req.query.table && req.query.id) {
      const { table, id } = req.query;
      if (table === 'tenders') { const t = await Tender.findById(id); if (t && nextValidStatus(t.status, 'cancelled')) { t.status = 'cancelled'; t.cancelled_reason = 'Cancelled by admin'; await t.save(); } }
      else if (table === 'vendors') { const v = await Vendor.findById(id); if (v) await User.updateOne({ _id: v.user_id }, { is_active: false }); }
      else if (table === 'users') await User.updateOne({ _id: id }, { is_active: false });
      else if (table === 'documents') { const d = await TenderDocument.findById(id); if (d) { try { fs.unlinkSync(path.join(__dirname, d.filepath)); } catch (e) {} await d.deleteOne(); } }
      await auditLog(user._id, role, table, id, 'delete', null, null, req.ip);
      return R('page=' + (req.query.back || page) + (req.query.id2 ? '&id=' + req.query.id2 : '') + '&msg=Deleted');
    }

    /* ---- GET: page data ---- */
    const d = { user, role, page, msg, unreadCount: await Notification.countDocuments({ user_id: user._id, is_read: false }) };
    switch (page) {
      case 'dashboard': {
        d.cards = []; 
        if (role === 'tender_handler') {
          d.cards = [
            { label: 'Active Tenders', value: await Tender.countDocuments({ status: { $in: ['published','accepting_bids'] } }), icon: 'fa-file-contract', color: 'primary' },
            { label: 'Under Evaluation', value: await Tender.countDocuments({ status: 'under_evaluation' }), icon: 'fa-scale-balanced', color: 'warning' },
            { label: 'Awaiting DVC', value: await Tender.countDocuments({ status: 'pending_dvc' }), icon: 'fa-user-tie', color: 'purple' },
            { label: 'Awarded', value: await Tender.countDocuments({ status: 'awarded' }), icon: 'fa-trophy', color: 'success' }];
          d.recentTenders = await Tender.find().sort({ createdAt: -1 }).limit(8);
        } else if (role === 'dvc') {
          d.pendingApprovals = await Approval.find({ status: 'pending', approver_id: user._id }).populate('tender_id');
          d.cards = [{ label: 'Pending Approvals', value: d.pendingApprovals.length, icon: 'fa-stamp', color: 'purple' },
            { label: 'Approved', value: await Approval.countDocuments({ approver_id: user._id, status: 'approved' }), icon: 'fa-check', color: 'success' }];
        } else if (role === 'procurement_head') {
          const byStatus = {};
          for (const s2 of TENDER_STATUSES) byStatus[s2] = await Tender.countDocuments({ status: s2 });
          d.cards = [
            { label: 'Total Tenders', value: await Tender.countDocuments(), icon: 'fa-file-contract', color: 'primary' },
            { label: 'Approved Vendors', value: await Vendor.countDocuments({ status: 'approved' }), icon: 'fa-building-circle-check', color: 'success' },
            { label: 'Pending Vendors', value: await Vendor.countDocuments({ status: 'pending' }), icon: 'fa-user-clock', color: 'warning' },
            { label: 'Blacklisted', value: await Vendor.countDocuments({ status: 'blacklisted' }), icon: 'fa-ban', color: 'danger' }];
          d.pipeline = byStatus;
          d.recentTenders = await Tender.find().sort({ createdAt: -1 }).limit(8);
        } else if (role === 'committee_member') {
          const memberships = await EvaluationSessionMember.find({ user_id: user._id });
          d.mySessions = await EvaluationSession.find({ _id: { $in: memberships.map(m => m.session_id) } }).populate('tender_id').sort({ createdAt: -1 });
          d.cards = [{ label: 'My Sessions', value: d.mySessions.length, icon: 'fa-scale-balanced', color: 'primary' },
            { label: 'Pending', value: d.mySessions.filter(s2 => s2.status !== 'completed').length, icon: 'fa-hourglass-half', color: 'warning' }];
        } else if (role === 'finance_officer') {
          d.pendingFees = await TenderParticipation.find({ status: 'interested' }).populate('vendor_id tender_id').limit(10);
          d.cards = [{ label: 'Pending Fees', value: await TenderParticipation.countDocuments({ status: 'interested' }), icon: 'fa-money-bill-wave', color: 'warning' },
            { label: 'Confirmed', value: await FeePayment.countDocuments({ status: 'confirmed' }), icon: 'fa-check-circle', color: 'success' },
            { label: 'Refunded', value: await FeePayment.countDocuments({ status: 'refunded' }), icon: 'fa-rotate-left', color: 'secondary' }];
        } else if (role === 'vendor') {
          d.recentTenders = await Tender.find({ status: { $in: ['published','accepting_bids'] } }).sort({ createdAt: -1 }).limit(8);
          d.myParticipations = await TenderParticipation.find({ vendor_id: su.vendorId }).populate('tender_id').sort({ createdAt: -1 });
          d.cards = [{ label: 'Open Tenders', value: d.recentTenders.length, icon: 'fa-file-contract', color: 'primary' },
            { label: 'My Participations', value: d.myParticipations.length, icon: 'fa-handshake', color: 'info' }];
        } else if (role === 'webmaster') {
          d.recentTenders = await Tender.find({ status: { $in: ['published','accepting_bids','draft'] } }).sort({ createdAt: -1 }).limit(10);
          d.cards = [{ label: 'Published', value: await Tender.countDocuments({ status: { $in: ['published','accepting_bids'] } }), icon: 'fa-globe', color: 'primary' },
            { label: 'Drafts', value: await Tender.countDocuments({ status: 'draft' }), icon: 'fa-pen', color: 'secondary' }];
        } else { // super_admin
          d.cards = [
            { label: 'Users', value: await User.countDocuments(), icon: 'fa-users', color: 'primary' },
            { label: 'Tenders', value: await Tender.countDocuments(), icon: 'fa-file-contract', color: 'info' },
            { label: 'Vendors', value: await Vendor.countDocuments(), icon: 'fa-building', color: 'success' },
            { label: 'Bids', value: await Bid.countDocuments(), icon: 'fa-envelope', color: 'warning' }];
          d.recentAudit = await AuditLog.find().sort({ createdAt: -1 }).limit(10).populate('user_id', 'name');
        }
        break;
      }
      case 'create_tender': d.categories = await Category.find(); break;
      case 'manage_tenders': {
        const f = {};
        if (req.query.q) f.$or = [{ title: new RegExp(req.query.q, 'i') }, { tender_number: new RegExp(req.query.q, 'i') }];
        if (req.query.status) f.status = req.query.status;
        if (role === 'vendor') {
          d.tenders = await Tender.find({ ...f, status: { $in: ['published','accepting_bids','bids_closed','awarded'] } }).sort({ createdAt: -1 });
          d.myParticipations = await TenderParticipation.find({ vendor_id: su.vendorId });
        } else d.tenders = await Tender.find(f).sort({ createdAt: -1 });
        d.q = req.query.q || ''; d.statusFilter = req.query.status || '';
        break;
      }
      case 'tender_detail': {
        d.tender = await Tender.findById(req.query.id).populate('created_by', 'name').populate('awarded_vendor_id');
        if (!d.tender) return R('page=manage_tenders&msg=Tender+not+found');
        d.documents = await TenderDocument.find({ tender_id: d.tender._id }).sort({ createdAt: -1 });
        d.participations = await TenderParticipation.find({ tender_id: d.tender._id }).populate('vendor_id');
        const canSeeVendors = ['super_admin','procurement_head','tender_handler','dvc'].includes(role);
        d.bids = canSeeVendors ? await Bid.find({ tender_id: d.tender._id }).populate('vendor_id') : await Bid.find({ tender_id: d.tender._id }).select('-vendor_id -encrypted_vendor');
        d.canSeeVendors = canSeeVendors;
        d.sessions = await EvaluationSession.find({ tender_id: d.tender._id }).sort({ createdAt: -1 });
        d.approvals = await Approval.find({ tender_id: d.tender._id }).populate('approver_id', 'name');
        d.timeline = await AuditLog.find({ entity_id: String(d.tender._id) }).sort({ createdAt: 1 }).populate('user_id', 'name');
        break;
      }
      case 'manage_vendors': {
        const f = {};
        if (req.query.q) f.$or = [{ company_name_en: new RegExp(req.query.q, 'i') }, { cr_number: new RegExp(req.query.q, 'i') }];
        if (req.query.status) f.status = req.query.status;
        if (req.query.category) f.categories = req.query.category;
        d.vendors = await Vendor.find(f).populate('user_id', 'name email phone is_active').sort({ createdAt: -1 });
        d.categories = await Category.find(); d.q = req.query.q || ''; d.statusFilter = req.query.status || '';
        break;
      }
      case 'pending_vendors': d.vendors = await Vendor.find({ status: 'pending' }).populate('user_id', 'name email phone'); break;
      case 'record_bid': {
        d.tender = await Tender.findById(req.query.id);
        d.bidCount = await Bid.countDocuments({ tender_id: req.query.id });
        d.participations = await TenderParticipation.find({ tender_id: req.query.id, status: 'fee_paid' });
        d.bids = await Bid.find({ tender_id: req.query.id }).select('bid_identifier envelope_count financial_amount submitted_at');
        break;
      }
      case 'create_evaluation': {
        d.tender = await Tender.findById(req.query.id);
        d.bids = await Bid.find({ tender_id: req.query.id }).select('bid_identifier');
        d.committee = await User.find({ role: 'committee_member', is_active: true });
        break;
      }
      case 'evaluate': {
        d.session = await EvaluationSession.findById(req.query.id).populate('tender_id');
        if (!d.session) return R('page=dashboard&msg=Session+not+found');
        d.bids = await Bid.find({ tender_id: d.session.tender_id._id }).select('bid_identifier financial_amount envelope_count');
        d.myEval = !!await Evaluation.findOne({ session_id: d.session._id, user_id: user._id });
        d.members = await EvaluationSessionMember.find({ session_id: d.session._id }).populate('user_id', 'name');
        d.submittedIds = (await Evaluation.distinct('user_id', { session_id: d.session._id })).map(String);
        if (d.session.status === 'completed') d.results = await computeResults(d.session);
        break;
      }
      case 'evaluation_results': {
        d.session = await EvaluationSession.findById(req.query.id).populate('tender_id');
        if (!d.session) return R('page=dashboard&msg=Session+not+found');
        d.results = await computeResults(d.session);
        break;
      }
      case 'approvals': d.approvals = await Approval.find({ approver_id: user._id }).populate('tender_id').sort({ createdAt: -1 }); break;
      case 'approval_detail': {
        d.approval = await Approval.findById(req.query.id).populate('tender_id');
        if (!d.approval) return R('page=approvals&msg=Not+found');
        d.session = await EvaluationSession.findOne({ tender_id: d.approval.tender_id._id, status: 'completed' }).sort({ createdAt: -1 });
        d.results = d.session ? await computeResults(d.session) : [];
        break;
      }
      case 'pending_fees': d.participations = await TenderParticipation.find({ status: 'interested' }).populate('vendor_id tender_id').sort({ createdAt: -1 }); break;
      case 'fee_history': {
        const f = {};
        if (req.query.status) f.status = req.query.status;
        d.payments = await FeePayment.find(f).populate('vendor_id tender_id confirmed_by').sort({ createdAt: -1 });
        d.statusFilter = req.query.status || '';
        break;
      }
      case 'notifications': d.notes = await Notification.find({ user_id: user._id }).sort({ createdAt: -1 }).limit(100); break;
      case 'audit_logs': {
        const f = {};
        if (req.query.entity) f.entity_type = req.query.entity;
        if (req.query.action) f.action = req.query.action;
        if (req.query.from || req.query.to) { f.createdAt = {}; if (req.query.from) f.createdAt.$gte = new Date(req.query.from); if (req.query.to) f.createdAt.$lte = new Date(req.query.to + 'T23:59:59'); }
        d.logs = await AuditLog.find(f).sort({ createdAt: -1 }).limit(200).populate('user_id', 'name');
        d.filters = { entity: req.query.entity || '', action: req.query.action || '', from: req.query.from || '', to: req.query.to || '' };
        break;
      }
      case 'manage_users': d.users = await User.find().sort({ createdAt: -1 }); break;
      case 'settings': d.settings = await Setting.find(); break;
      case 'broadcast_notification': break;
      case 'reports': {
        const f = {};
        if (req.query.from || req.query.to) { f.createdAt = {}; if (req.query.from) f.createdAt.$gte = new Date(req.query.from); if (req.query.to) f.createdAt.$lte = new Date(req.query.to + 'T23:59:59'); }
        const tenders = await Tender.find(f);
        d.catCounts = {}; d.statusCounts = {};
        for (const t of tenders) { d.catCounts[t.category] = (d.catCounts[t.category] || 0) + 1; d.statusCounts[t.status] = (d.statusCounts[t.status] || 0) + 1; }
        d.summary = tenders.slice(0, 50);
        d.cards = [
          { label: 'Total Tenders', value: tenders.length, icon: 'fa-file-contract', color: 'primary' },
          { label: 'Awarded', value: tenders.filter(t => ['awarded','completed'].includes(t.status)).length, icon: 'fa-trophy', color: 'success' },
          { label: 'Cancelled', value: tenders.filter(t => t.status === 'cancelled').length, icon: 'fa-ban', color: 'danger' },
          { label: 'Fees Collected (OMR)', value: (await FeePayment.aggregate([{ $match: { status: 'confirmed' } }, { $group: { _id: null, s: { $sum: '$amount' } } }]))[0]?.s || 0, icon: 'fa-money-bill', color: 'info' }];
        d.filters = { from: req.query.from || '', to: req.query.to || '' };
        break;
      }
      case 'my_profile': d.vendor = await Vendor.findById(su.vendorId); d.categories = await Category.find(); break;
      case 'view_bid_docs': {
        d.tender = await Tender.findById(req.query.id);
        d.bids = await Bid.find({ tender_id: req.query.id }).select('bid_identifier');
        d.bidDocs = await BidDocument.find({ bid_id: { $in: d.bids.map(x => x._id) } }).populate('bid_id', 'bid_identifier');
        break;
      }
      default: d.page = 'dashboard'; d.cards = [];
    }
    res.render('app', d);
  } catch (e) {
    console.error(e);
    res.redirect('/app?page=dashboard&msg=' + encodeURIComponent('Error: ' + e.message));
  }
}
app.get('/app', requireAuth, appHandler);
app.post('/app', requireAuth, appHandler);

/* ============================== START ============================== */
const PORT = process.env.PORT || 3000;
mongoose.connect(MONGODB_URI).then(async () => {
  console.log('MongoDB connected');
  await seed();
  app.listen(PORT, () => console.log('DU-TMS running on port ' + PORT));
}).catch(e => { console.error('Mongo connection failed:', e.message); process.exit(1); });
