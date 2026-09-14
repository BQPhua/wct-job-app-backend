// ============================================================================
// WCT Group Job Application — client logic
// ============================================================================

const STEPS = ['start','personal','language','education','experience','questions',
               'referees','attachments','review','consent-lang','pdpa','final','done'];

let state = {
  step: 'start',
  id: null,
  reference_no: null,
  status: 'draft',
  business_unit: '',
  name_nric: '', alias: '',
  permanent_address: '', permanent_postcode: '',
  correspondence_address: '', correspondence_postcode: '',
  tel_residence: '', tel_office: '', mobile_phone: '', email: '',
  place_of_birth: '', nric_new: '', passport_number: '', citizen: '', marital_status: '',
  date_of_birth: '', age: '', bumiputra: '', race: '',
  epf_no: '', income_tax_no: '', tax_branch: '', socso_no: '', bank_account_no: '',
  cidb_green_card_no: '', cidb_branch: '',
  language_ability: [
    {language:'Bahasa Malaysia', spoken:'', written:''},
    {language:'English', spoken:'', written:''},
    {language:'Mandarin', spoken:'', written:''},
    {language:'Others (please state)', spoken:'', written:''}
  ],
  education: [ {type:'School', name:'', from_year:'', to_year:'', qualification:''} ],
  working_experience: [ {employer:'', from:'', to:'', is_current:false, position:'', remuneration:'', responsibilities:''} ],
  resignation_notice_required:'', notice_period:'', date_available_to_start:'',
  expected_basic_salary:'',
  relatives_in_company:'', relatives_name:'', relatives_relationship:'',
  referral_person:'', referral_name:'', referral_department:'',
  own_transport_motorcar:'', own_transport_motorcycle:'',
  willing_based_outside_klang_valley:'',
  physical_defects:'', physical_defects_specify:'',
  arrested_convicted:'', arrested_convicted_specify:'',
  referee1:{name:'',designation:'',relationship:'',contact:''},
  referee2:{name:'',designation:'',relationship:'',contact:''},
  declaration_lawsuit:'', declaration_lawsuit_specify:'',
  declaration_other_matters:'', declaration_other_matters_specify:'',
  profile_picture_url:'', attachments:[],
  language_choice:'', jts_agreed:false, pdpa_agreed:false
};

const HIGHEST_EDUCATION_OPTIONS = [
  'No Formal Education','Pre-Primary Education','Primary Education','Middle School',
  'Secondary Education or High School','GED (General Educational Development)',
  'Vocational Qualification','Technical Education','Certificate Program',
  'Associate Degree',"Bachelor's Degree",'Post-Graduate Diploma',
  'Professional Certification',"Master's Degree",'Doctoral Degree (Ph.D., Ed.D., etc.)',
  'Professional Degree (MD, JD, DDS, etc.)','Post-Doctoral Studies','Other'
];

let currentUser = null; // populated at boot from the cached login/register/oauth response (see api.js getUser())

const root = document.getElementById('cardRoot');
const progressBar = document.getElementById('progressBar');
const topRefDisplay = document.getElementById('topRefDisplay');

function showLoading(text){ document.getElementById('loadingText').innerText = text||'Working...'; document.getElementById('loadingOverlay').style.display='flex'; }
function hideLoading(){ document.getElementById('loadingOverlay').style.display='none'; }

function updateField(key, value){ state[key] = value; }
function updateNested(obj, key, value){ obj[key] = value; }
function updateArrayField(arrName, idx, key, value){ state[arrName][idx][key] = value; }

function goStep(s){ state.step = s; window.scrollTo(0,0); render(); }

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
function currentPatch(){
  const p = {...state};
  delete p.step; delete p.id; delete p.reference_no; delete p.status;
  delete p.jts_agreed; delete p.pdpa_agreed;
  // Strip empty-string values so the database's coalesce() correctly keeps
  // the existing column value instead of overwriting it with ''. Postgres's
  // coalesce() only falls back on NULL, not on empty string — so a blank
  // field sent as '' would actively overwrite good data, and for
  // constrained columns (like language_choice, which only allows 'BM'/'EN')
  // would fail the save entirely, exactly like the earlier date-field bug.
  Object.keys(p).forEach(key => {
    if(p[key] === '') delete p[key];
  });
  return p;
}

async function saveDraft(){
  if(!state.id) return true;
  showLoading('Saving your progress...');
  let success = true;
  try{
    const { error } = await apiTry(() => api.patch(`/applications/${state.id}`, {
      reference_no: state.reference_no, patch: currentPatch()
    }));
    if(error){
      console.error(error);
      success = false;
      alert(`Your progress could not be saved:\n\n${error.message}\n\nPlease try again — if this keeps happening, contact support before continuing, since your latest changes have NOT been saved.`);
    }
  } catch(e){
    console.error(e);
    success = false;
    alert(`Your progress could not be saved:\n\n${e.message}\n\nPlease try again — if this keeps happening, contact support before continuing, since your latest changes have NOT been saved.`);
  }
  hideLoading();
  return success;
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------
function renderProgress(){
  const visibleSteps = STEPS.filter(s=>s!=='start' && s!=='done');
  const idx = visibleSteps.indexOf(state.step);
  progressBar.innerHTML = visibleSteps.map((s,i)=>{
    let cls='seg'; if(i<idx) cls+=' done'; if(i===idx) cls+=' active';
    return `<div class="${cls}"></div>`;
  }).join('');
  const refPart = state.reference_no ? `<span style="margin-right:14px;">Ref: ${state.reference_no}</span>` : '';
  const userPart = currentUser ? `<span style="margin-right:14px;">${esc(currentUser.email)}</span><button class="btn" style="background:#fff;color:var(--navy);border:1px solid #fff;padding:6px 12px;font-size:12.5px;" onclick="signOut()">Sign out</button>` : '';
  topRefDisplay.innerHTML = refPart + userPart;
}

// ---------------------------------------------------------------------------
// MAIN RENDER DISPATCH
// ---------------------------------------------------------------------------
function render(){
  renderProgress();
  switch(state.step){
    case 'start': root.innerHTML = tplStart(); break;
    case 'personal': root.innerHTML = tplPersonal(); break;
    case 'language': root.innerHTML = tplLanguage(); break;
    case 'education': root.innerHTML = tplEducation(); break;
    case 'experience': root.innerHTML = tplExperience(); break;
    case 'questions': root.innerHTML = tplQuestions(); break;
    case 'referees': root.innerHTML = tplReferees(); break;
    case 'attachments': root.innerHTML = tplAttachments(); break;
    case 'review': root.innerHTML = tplReview(); break;
    case 'consent-lang': root.innerHTML = tplConsentLang(); break;
    case 'pdpa': root.innerHTML = tplPdpa(); break;
    case 'final': root.innerHTML = tplFinal(); break;
    case 'done': root.innerHTML = tplDone(); break;
    case 'onboarding': root.innerHTML = tplOnboarding(); break;
    case 'exit-interview': root.innerHTML = tplExitInterview(); break;
    case 'my-application-detail': root.innerHTML = tplMyApplicationDetail(); break;
  }
}

// ---------------------------------------------------------------------------
// STEP: start (new application, or pick up one of the signed-in user's own drafts)
// ---------------------------------------------------------------------------
let myApplications = [];

let linkBusinessUnit = null; // which business unit this candidate is applying
// under, derived from the URL (?bu=Mall etc.) rather than a dropdown —
// see boot() below.

function statusBadgeHtml(status){
  const label = (status||'').replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase());
  return `<span class="status-badge ${esc(status)}">${esc(label)}</span>`;
}

function tplStart(){
  const drafts = myApplications.filter(a=>a.status==='draft');
  const others = myApplications.filter(a=>a.status!=='draft');

  return `
    <div class="step-eyebrow">Welcome${currentUser?.name ? ', '+esc(currentUser.name) : ''}</div>
    <h2>Employment Application</h2>
    <p class="step-desc">Apply once — your application will be routed to the right hiring team across E&amp;C, Land, and Mall.</p>

    ${drafts.length ? `
      <div class="section-title" style="margin-top:0;">Continue a Saved Application</div>
      ${drafts.map(a=>`
        <div class="draft-banner">
          <div class="draft-banner-icon">📝</div>
          <div class="draft-banner-body">
            <div class="draft-banner-title">${esc(a.reference_no)}</div>
            <div class="draft-banner-meta">${esc(a.business_unit)} · Draft in progress</div>
          </div>
          <div class="draft-banner-actions" style="display:flex;gap:8px;">
            <button class="btn btn-primary btn-sm" onclick="continueDraft('${a.id}')">Continue →</button>
            <button class="btn" style="background:var(--danger);color:#fff;" onclick="deleteDraft('${a.id}','${esc(a.reference_no)}')">Delete</button>
          </div>
        </div>
      `).join('')}
    ` : ''}

    ${others.length ? `
      <div class="section-title" style="margin-top:${drafts.length?'22px':'0'};">Your Previous Applications</div>
      <table class="history-table">
        <thead><tr><th>Reference</th><th>Unit</th><th>Status</th><th>Submitted</th><th style="width:160px;">Actions</th></tr></thead>
        <tbody>
          ${others.map(a=>`
            <tr>
              <td><strong><a href="#" onclick="viewMyApplication('${a.id}'); return false;" style="color:var(--navy-2);text-decoration:underline;">${esc(a.reference_no)}</a></strong></td>
              <td>${esc(a.business_unit)}</td>
              <td>${statusBadgeHtml(a.status)}</td>
              <td>${a.submitted_at ? new Date(a.submitted_at).toLocaleDateString() : '—'}</td>
              <td>
                <div class="history-actions">
                  ${a.status==='hired' ? `<button class="btn btn-primary btn-sm" onclick="openOnboarding('${a.id}')">Onboarding Details</button>` : ''}
                  ${a.status==='offboarding' ? `<button class="btn" style="background:#6B6D70;color:#fff;" onclick="openExitInterview('${a.id}')">Exit Interview Form</button>` : ''}
                  ${a.status!=='hired' && a.status!=='offboarding' ? '<span style="color:var(--ink-soft);font-size:12.5px;">—</span>' : ''}
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : ''}

    <div class="section-title" style="margin-top:26px;">Start a New Application</div>
    ${VALID_BUSINESS_UNITS.includes(linkBusinessUnit) ? `
      <p class="step-desc" style="margin-top:0;">You are applying for a position with <strong>${esc(linkBusinessUnit)}</strong>.</p>
      ${others.length ? `
        <div class="error-banner" style="background:#FDF3E3;border-color:#E2D3AC;color:#9C7A0E;">
          You've previously submitted ${others.length===1?'an application':others.length+' applications'} (see "Your Previous Applications" above). Submitting a new one may create a duplicate — please check the table first if you're unsure whether you've already applied.
        </div>
      ` : ''}
      <div id="startErr"></div>
      <div class="btn-row"><div></div><div class="right"><button class="btn btn-primary" onclick="startNewApplication()">Begin Application →</button></div></div>
    ` : `
      <div class="error-banner">This application link doesn't specify a valid business unit. Please use the link provided by HR for the specific business unit you're applying to (E&amp;C, Land, or Mall).</div>
    `}
  `;
}

const VALID_BUSINESS_UNITS = ['E&C', 'Land', 'Mall'];

async function deleteDraft(id, referenceNo){
  if(!confirm(`Permanently delete the draft application "${referenceNo}"? This cannot be undone.`)) return;
  showLoading('Deleting draft...');
  try{
    const { error } = await apiTry(() => api.del(`/applications/${id}`));
    if(error) throw error;
    await loadMyApplications();
    render();
  } catch(e){
    alert('Error deleting draft: ' + e.message);
  }
  hideLoading();
}

async function continueDraft(id){
  const row = myApplications.find(a=>a.id===id);
  if(!row) return;
  loadStateFromRow(row);
  goStep('personal');
}

let viewingApplicationId = null;
function viewMyApplication(id){
  viewingApplicationId = id;
  goStep('my-application-detail');
}

function tplMyApplicationDetail(){
  const a = myApplications.find(x=>x.id===viewingApplicationId);
  if(!a){
    return `
      <div class="step-eyebrow">Application Details</div>
      <h2>Not found</h2>
      <p class="step-desc">This application could not be found.</p>
      <button class="btn btn-ghost" onclick="goStep('start')">← Back to My Applications</button>
    `;
  }
  const refs = [a.referee1, a.referee2].filter(r => r && r.name);
  // Full field list — kept in sync with tplReview() (the pre-submission
  // review step) so a candidate revisiting a submitted application from "My
  // Applications" sees everything they filled in, not just a subset.
  return `
    <div class="step-eyebrow">${esc(a.reference_no)}</div>
    <h2>Application Details</h2>
    <p class="step-desc">${esc(a.business_unit)} · ${statusBadgeHtml(a.status)} · Submitted ${a.submitted_at ? new Date(a.submitted_at).toLocaleDateString() : '—'}</p>

    <div class="review-block">
      <h4>Personal Particulars</h4>
      ${rrow('Name (per NRIC)', a.name_nric)}
      ${rrow('Alias', a.alias)}
      ${rrow('Permanent Address', (a.permanent_address||'')+' '+(a.permanent_postcode||''))}
      ${rrow('Correspondence Address', (a.correspondence_address||'')+' '+(a.correspondence_postcode||''))}
      ${rrow('Mobile', a.mobile_phone)}
      ${rrow('Email', a.email)}
      ${rrow('NRIC', a.nric_new)}
      ${rrow('Date of Birth / Age', (a.date_of_birth||'—')+' / '+(a.age||'—'))}
      ${rrow('Marital Status', a.marital_status)}
      ${rrow('Race / Bumiputra', (a.race||'—')+' / '+(a.bumiputra||'—'))}
    </div>

    <div class="review-block">
      <h4>Language Ability</h4>
      ${(a.language_ability||[]).map(r=>rrow(r.language, `Spoken: ${r.spoken||'—'}, Written: ${r.written||'—'}`)).join('') || rrow('Language Ability','None provided')}
    </div>

    <div class="review-block">
      <h4>Education</h4>
      ${(a.education||[]).map(r=>rrow(r.type, `${r.name} (${r.from_year}–${r.to_year}) — ${r.qualification}${r.course_name?' — '+r.course_name:''}`)).join('') || rrow('Education','None provided')}
    </div>

    <div class="review-block">
      <h4>Working Experience</h4>
      ${(a.working_experience||[]).map(r=>rrow(r.position||'Position', `${r.employer} (${r.from}–${r.is_current?'Present':r.to})`)).join('') || rrow('Experience','None provided')}
    </div>

    <div class="review-block">
      <h4>Employment Questions</h4>
      ${rrow('Resignation Notice Required', a.resignation_notice_required)}
      ${rrow('Date Available to Start', a.date_available_to_start)}
      ${rrow('Expected Basic Salary', a.expected_basic_salary)}
      ${rrow('Relatives in Company', a.relatives_in_company==='Yes' ? `Yes — ${a.relatives_name} (${a.relatives_relationship})` : a.relatives_in_company)}
      ${rrow('Referred by Anyone', a.referral_person==='Yes' ? `Yes — ${a.referral_name}, ${a.referral_department}` : a.referral_person)}
      ${rrow('Own Transport (Car / Motorcycle)', `${a.own_transport_motorcar||'—'} / ${a.own_transport_motorcycle||'—'}`)}
      ${rrow('Willing Outside Klang Valley', a.willing_based_outside_klang_valley)}
      ${rrow('Physical Defects', a.physical_defects)}
      ${rrow('Arrested / Convicted', a.arrested_convicted)}
    </div>

    ${refs.length ? `
    <div class="review-block">
      <h4>Referees</h4>
      ${refs.map((r,i)=>rrow(`Referee ${i+1}`, `${r.name} — ${r.designation} · ${r.relationship} · ${r.contact}`)).join('')}
    </div>` : ''}

    <div class="review-block">
      <h4>Declarations</h4>
      ${rrow('(B) Lawsuits/Proceedings', a.declaration_lawsuit==='Yes' ? `Yes — ${a.declaration_lawsuit_specify}` : a.declaration_lawsuit)}
      ${rrow('(C) Other Matters', a.declaration_other_matters==='Yes' ? `Yes — ${a.declaration_other_matters_specify}` : a.declaration_other_matters)}
    </div>

    <div class="review-block">
      <h4>Attachments</h4>
      <div class="file-thumb-row">
        <div class="k" style="width:44%;">Passport Size Photo</div>
        <div class="v" style="width:56%;">
          ${a.profile_picture_url
            ? `<img src="${a.profile_picture_url}" class="profile-thumb-lg">`
            : `<span style="color:var(--ink-soft);">Not uploaded</span>`}
        </div>
      </div>
      ${(a.attachments||[]).length ? a.attachments.map(f=>{
        const isImg = f.type && f.type.startsWith('image/');
        return `<div class="file-thumb-row">
          <div class="k" style="width:44%;"></div>
          <div class="v" style="width:56%;display:flex;align-items:center;gap:10px;">
            <span class="file-thumb">${isImg ? `<img src="${f.url}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">` : '📄'}</span>
            <a href="${f.url}" target="_blank">${esc(f.name)}</a>
          </div>
        </div>`;
      }).join('') : rrow('Documents', 'None attached')}
    </div>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="goStep('start')">← Back to My Applications</button>
      <div class="right"><button class="btn btn-primary" onclick="exportMyApplicationPdfById('${a.id}')">📄 Download as PDF</button></div>
    </div>
  `;
}

async function loadMyApplications(){
  try{
    const { data, error } = await apiTry(() => api.get('/applications/mine'));
    if(error) throw error;
    myApplications = data || [];
  } catch(e){ console.error(e); myApplications = []; }
}

async function startNewApplication(){
  if(!VALID_BUSINESS_UNITS.includes(linkBusinessUnit)){
    document.getElementById('startErr').innerHTML = `<div class="error-banner">This application link doesn't specify a valid business unit.</div>`;
    return;
  }
  showLoading('Creating your application...');
  try{
    const { data, error } = await apiTry(() => api.post('/applications', { business_unit: linkBusinessUnit }));
    if(error) throw error;
    state.id = data.id; state.reference_no = data.reference_no;
    state.business_unit = linkBusinessUnit;
    // Pre-fill from the signed-in account
    if(currentUser){
      state.name_nric = state.name_nric || currentUser.name || '';
      state.email = state.email || currentUser.email || '';
    }
    await saveDraft();
    hideLoading();
    goStep('personal');
  } catch(e){
    hideLoading();
    document.getElementById('startErr').innerHTML = `<div class="error-banner">Something went wrong: ${e.message}</div>`;
  }
}

function loadStateFromRow(row){
  Object.keys(row).forEach(k=>{
    if(k in state || ['id','reference_no','status'].includes(k)){
      if(k==='language_ability' && (!row[k] || row[k].length===0)) return;
      if(k==='education' && (!row[k] || row[k].length===0)) return;
      if(k==='working_experience' && (!row[k] || row[k].length===0)) return;
      if(k==='attachments' && !row[k]) return;
      state[k] = row[k] ?? state[k];
    }
  });
  // If the saved SOCSO number differs from the NRIC, treat it as intentionally
  // edited so we don't silently overwrite it if they revisit the NRIC field.
  socsoManuallyEdited = !!(state.socso_no && state.socso_no !== state.nric_new);
}

// ---------------------------------------------------------------------------
// STEP: personal particulars
// ---------------------------------------------------------------------------
function tplPersonal(){
  return `
    <div class="step-eyebrow">Step 1 of 8</div>
    <h2>Personal Particulars</h2>
    <p class="step-desc">Applying with <strong>${esc(state.business_unit)}</strong></p>

    <div class="grid">
      <div class="field"><label>Name (per NRIC / Passport) <span class="req-star">*</span></label><input type="text" placeholder="e.g. Ahmad Bin Ali" value="${esc(state.name_nric)}" oninput="updateField('name_nric', this.value)"></div>
      <div class="field"><label>Alias <span class="opt-tag">(optional)</span></label><input type="text" value="${esc(state.alias)}" oninput="updateField('alias', this.value)"></div>
    </div>

    <div class="field"><label>Permanent Address <span class="req-star">*</span></label><textarea placeholder="e.g. Address Line 1: 12 Jalan Damai&#10;Address Line 2: Taman Sentosa&#10;Address Line 3: Petaling Jaya" oninput="updateField('permanent_address', this.value)">${esc(state.permanent_address)}</textarea></div>
    <div class="grid">
      <div class="field"><label>Postcode <span class="req-star">*</span></label><input type="text" placeholder="e.g. 50450" value="${esc(state.permanent_postcode)}" oninput="updateField('permanent_postcode', this.value)"></div>
      <div></div>
    </div>

    <div class="field"><label>Correspondence Address <span class="opt-tag">(if different from permanent address)</span></label><textarea id="correspondenceAddressInput" oninput="handleCorrespondenceAddressChange(this.value)">${esc(state.correspondence_address)}</textarea></div>
    <div class="grid">
      <div class="field"><label>Postcode <span class="opt-tag">(optional)</span></label><input type="text" id="correspondencePostcodeInput" value="${esc(state.correspondence_postcode)}" oninput="updateField('correspondence_postcode', this.value)"></div>
      <div></div>
    </div>

    <div class="grid g3">
      <div class="field"><label>Tel — Residence <span class="opt-tag">(optional)</span></label><input type="tel" placeholder="e.g. 03-1234 5678" value="${esc(state.tel_residence)}" oninput="updateField('tel_residence', this.value)"></div>
      <div class="field"><label>Tel — Office <span class="opt-tag">(optional)</span></label><input type="tel" placeholder="e.g. 03-8765 4321" value="${esc(state.tel_office)}" oninput="updateField('tel_office', this.value)"></div>
      <div class="field"><label>Mobile Phone <span class="req-star">*</span></label><input type="tel" placeholder="e.g. 012-345 6789" value="${esc(state.mobile_phone)}" oninput="updateField('mobile_phone', this.value)"></div>
    </div>

    <div class="grid">
      <div class="field"><label>E-mail Address <span class="req-star">*</span></label><input type="email" placeholder="e.g. ahmad.ali@example.com" value="${esc(state.email)}" oninput="updateField('email', this.value)"></div>
      <div class="field"><label>Place of Birth <span class="req-star">*</span></label><input type="text" placeholder="e.g. Kuala Lumpur" value="${esc(state.place_of_birth)}" oninput="updateField('place_of_birth', this.value)"></div>
    </div>

    <div class="section-title">Identification</div>
    <div class="grid g3">
      <div class="field">
        <label>Citizen <span class="req-star">*</span></label>
        <select onchange="handleCitizenChange(this.value)">
          <option value="">Select</option>
          <option ${state.citizen==='Malaysian'?'selected':''}>Malaysian</option>
          <option ${state.citizen==='Non-Malaysian'?'selected':''}>Non-Malaysian</option>
        </select>
      </div>
      <div class="field">
        <label>NRIC No. (without dash) ${state.citizen==='Malaysian' ? '<span class="req-star">*</span>' : '<span class="opt-tag">(Malaysians only)</span>'}</label>
        <input type="text" value="${esc(state.nric_new)}" placeholder="e.g. 900101011234" maxlength="14"
          ${state.citizen==='Non-Malaysian' ? 'disabled style="background:#F2F2F1;"' : ''}
          oninput="handleNricChange(this.value)">
        <div id="nricValidationMsg" class="hint"></div>
      </div>
      <div class="field">
        <label>Passport Number ${state.citizen==='Non-Malaysian' ? '<span class="req-star">*</span>' : '<span class="opt-tag">(optional)</span>'}</label>
        <input type="text" value="${esc(state.passport_number)}" placeholder="e.g. A12345678" oninput="updateField('passport_number', this.value)">
      </div>
    </div>
    <div class="grid g3">
      <div class="field">
        <label>Date of Birth <span class="req-star">*</span></label>
        <div style="display:flex;gap:6px;">
          <input type="text" id="dobTextInput" inputmode="numeric" autocomplete="off" placeholder="DD/MM/YYYY" maxlength="10"
            value="${esc(formatDobForDisplay(state.date_of_birth))}" oninput="handleDobTextInput(this)" style="flex:1;">
          <button type="button" class="btn btn-outline btn-sm" title="Pick from calendar" style="padding:0 10px;"
            onclick="const p=document.getElementById('dobPickerInput'); if(p.showPicker){p.showPicker();} else {p.focus();}">📅</button>
        </div>
        <!-- Kept as a real (but visually hidden) native date input purely so
             the 📅 button can open the browser's own calendar picker via
             showPicker() — the visible field above is the actual typing UI,
             always displayed/entered as DD/MM/YYYY regardless of the
             browser's locale, since a bare <input type="date"> renders in
             whatever format the browser/OS locale picks (e.g. mm/dd/yyyy in
             en-US), which isn't what candidates here expect. -->
        <input type="date" id="dobPickerInput" value="${esc(state.date_of_birth)}" onchange="handleDobChange(this.value)"
          style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">
        <div class="hint">${state.citizen==='Malaysian' ? "Auto-filled from your NRIC — adjust here if it doesn't look right." : 'Type it as DDMMYYYY (e.g. 13042005 → 13/04/2005), or use the 📅 picker.'}</div>
      </div>
      <div class="field"><label>Age</label><input type="number" id="ageInput" value="${esc(state.age)}" readonly style="background:#F2F2F2;"></div>
      <div class="field"><label>Marital Status <span class="req-star">*</span></label>
        <select oninput="updateField('marital_status', this.value)">
          <option value="">Select</option>
          ${['Single','Married','Divorced','Widowed'].map(o=>`<option ${state.marital_status===o?'selected':''}>${o}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="grid g3">
      <div class="field"><label>Bumiputra <span class="req-star">*</span></label>
        <select oninput="updateField('bumiputra', this.value)">
          <option value="">Select</option><option ${state.bumiputra==='Yes'?'selected':''}>Yes</option><option ${state.bumiputra==='No'?'selected':''}>No</option>
        </select>
      </div>
      <div class="field"><label>Race <span class="req-star">*</span></label><input type="text" placeholder="e.g. Malay" value="${esc(state.race)}" oninput="updateField('race', this.value)"></div>
      <div></div>
    </div>

    ${navButtonsValidated('start','language', validatePersonalStep)}
  `;
}

function validatePersonalStep(){
  const errs = [];
  if(!state.name_nric.trim()) errs.push('Please enter your name (per NRIC/Passport).');
  if(!state.permanent_address.trim()) errs.push('Please enter your permanent address.');
  if(!state.permanent_postcode.trim()) errs.push('Please enter your permanent address postcode.');
  if(!state.mobile_phone.trim()) errs.push('Please enter your mobile phone number.');
  if(!state.email.trim()) errs.push('Please enter your email address.');
  if(!state.place_of_birth.trim()) errs.push('Please enter your place of birth.');
  if(!state.citizen) errs.push('Please select your citizenship.');
  if(state.citizen === 'Malaysian'){
    const digits = (state.nric_new||'').replace(/[^0-9]/g,'');
    if(!state.nric_new.trim()) errs.push('Please enter your NRIC number.');
    else if(digits.length !== 12) errs.push('NRIC number must be exactly 12 digits.');
  } else if(state.citizen === 'Non-Malaysian'){
    if(!state.passport_number.trim()) errs.push('Please enter your passport number.');
  }
  if(!state.date_of_birth) errs.push('Please provide your date of birth.');
  if(!state.marital_status) errs.push('Please select your marital status.');
  if(!state.bumiputra) errs.push('Please answer the Bumiputra question.');
  if(!state.race.trim()) errs.push('Please enter your race.');
  return errs;
}

// SOCSO number auto-mirrors the NRIC field as the person types it, since for
// most Malaysian employees the two match. It stays editable — once the person
// types into the SOCSO field directly, we stop overwriting it from NRIC.
let socsoManuallyEdited = false;

// ============================================================================
// POST-HIRE ONBOARDING — multi-step wizard (one section at a time, matching
// the main application's UX) and a Salary Crediting form matching the
// actual company document exactly.
// ============================================================================

const ONBOARDING_STEPS = ['statutory','spouse_children','emergency_beneficiary','salary','review'];

let onboardingAppId = null;
let onboardingState = null;
let onboardingStep = 'statutory';

async function openOnboarding(applicationId){
  showLoading('Loading onboarding forms...');
  try{
    const { data, error } = await apiTry(() => api.get(`/onboarding/${applicationId}`));
    if(error) throw error;
    onboardingAppId = applicationId;
    onboardingState = data;
    onboardingStep = onboardingState.status === 'completed' ? 'review' : 'statutory';
    // If a salary account no. was already saved and differs from the bank
    // account no., the candidate deliberately diverged them — don't clobber
    // that on reopening.
    salaryAccountManuallyEdited = !!(onboardingState.salary_account_no && onboardingState.salary_account_no !== onboardingState.bank_account_no);
    hideLoading();
    goStep('onboarding');
  } catch(e){
    hideLoading();
    alert('Could not load onboarding forms: ' + e.message);
  }
}

async function saveOnboarding(showAlert){
  try{
    const patch = {
      epf_no: document.getElementById('ob_epf_no')?.value.trim() || '',
      income_tax_no: document.getElementById('ob_income_tax_no')?.value.trim() || '',
      tax_branch: document.getElementById('ob_tax_branch')?.value.trim() || '',
      socso_no: document.getElementById('ob_socso_no')?.value.trim() || '',
      bank_account_no: document.getElementById('ob_bank_account_no')?.value.trim() || '',
      cidb_green_card_no: document.getElementById('ob_cidb_green_card_no')?.value.trim() || '',
      spouse_name: document.getElementById('ob_spouse_name')?.value.trim() || '',
      spouse_nric: document.getElementById('ob_spouse_nric')?.value.trim() || '',
      spouse_date_of_birth: document.getElementById('ob_spouse_dob')?.value || '',
      spouse_working: document.querySelector('input[name="ob_spouse_working"]:checked')?.value || '',
      children_below_18: onboardingState.children_below_18,
      children_18_to_23: onboardingState.children_18_to_23,
      emergency_contacts: onboardingState.emergency_contacts,
      beneficiary_name: document.getElementById('ob_beneficiary_name')?.value.trim() || '',
      beneficiary_relationship: document.getElementById('ob_beneficiary_relationship')?.value.trim() || '',
      beneficiary_contact: document.getElementById('ob_beneficiary_contact')?.value.trim() || '',
      tp3_data: onboardingState.tp3_data,
      salary_company: document.querySelector('input[name="ob_salary_company"]:checked')?.value || onboardingState.salary_company || '',
      salary_bank: document.getElementById('ob_salary_bank')?.value.trim() || '',
      salary_account_no: document.getElementById('ob_salary_account_no')?.value.trim() || '',
      salary_ic_submitted: document.getElementById('ob_salary_ic')?.value.trim() || ''
    };
    // Only the currently-displayed onboarding step's fields actually exist
    // in the DOM at any moment — every other step's fields fall back to ''
    // above. Strip those before sending, so calling save from e.g. the
    // Spouse & Children step doesn't send epf_no: '' and blank out an
    // already-saved Statutory Details value via coalesce(). This mirrors
    // the identical fix already applied to the main application's
    // currentPatch() for the same reason. Array/object fields pulled
    // directly from onboardingState (children, contacts, tp3_data) don't
    // have this problem — they reflect true current state regardless of
    // which step is on screen — so they're left untouched here.
    Object.keys(patch).forEach(key => {
      if(patch[key] === '') delete patch[key];
    });
    const { data, error } = await apiTry(() => api.patch(`/onboarding/${onboardingAppId}`, { patch }));
    if(error) throw error;
    onboardingState = data;
    if(showAlert) alert('Saved.');
    return true;
  } catch(e){ alert('Error saving: ' + e.message); return false; }
}

async function onboardingGoStep(step){
  const ok = await saveOnboarding(false);
  if(ok){ onboardingStep = step; render(); window.scrollTo(0,0); }
}

// Applies the annual limit cap live as the candidate types, updating the
// field in place (no full re-render) so typing doesn't lose focus.
function addChildBelow18(){ onboardingState.children_below_18 = [...onboardingState.children_below_18, {name:'',gender:'',nric:'',date_of_birth:'',course_name:'',tax_relief:false}]; render(); }
function removeChildBelow18(i){ onboardingState.children_below_18.splice(i,1); render(); }
function updateChildBelow18(i, key, val){ onboardingState.children_below_18[i][key] = val; }

function addChild18to23(){ onboardingState.children_18_to_23 = [...onboardingState.children_18_to_23, {name:'',date_of_birth:'',course_name:'',gender:'',nric:'',tax_relief:false}]; render(); }
function removeChild18to23(i){ onboardingState.children_18_to_23.splice(i,1); render(); }
function updateChild18to23(i, key, val){ onboardingState.children_18_to_23[i][key] = val; }

function handleSpouseNricInput(val){
  onboardingState.spouse_nric = val;
  const derivedDob = deriveDobFromNric(val);
  if(derivedDob){
    onboardingState.spouse_date_of_birth = derivedDob;
    const dobEl = document.getElementById('ob_spouse_dob');
    if(dobEl) dobEl.value = derivedDob; // update in place, no full re-render (keeps focus while typing)
  }
}

function handleChildBelow18NricInput(i, val){
  updateChildBelow18(i, 'nric', val);
  const derivedDob = deriveDobFromNric(val);
  if(derivedDob){
    onboardingState.children_below_18[i].date_of_birth = derivedDob;
    const dobEl = document.getElementById(`childBelow18Dob${i}`);
    if(dobEl) dobEl.value = derivedDob;
  }
}

function handleChild18to23NricInput(i, val){
  updateChild18to23(i, 'nric', val);
  const derivedDob = deriveDobFromNric(val);
  if(derivedDob){
    onboardingState.children_18_to_23[i].date_of_birth = derivedDob;
    const dobEl = document.getElementById(`child18to23Dob${i}`);
    if(dobEl) dobEl.value = derivedDob;
  }
}

// Education level dropdown used for both children tables — kindergarten
// through college/university, default "-" (blank/not applicable, since a
// young child may not be in school yet).
const CHILD_EDUCATION_LEVELS = ['-', 'Kindergarten', 'Primary School', 'Secondary School', 'College/University'];
function childEducationOptionsHtml(selected){
  return CHILD_EDUCATION_LEVELS.map(o=>`<option value="${o==='-'?'':o}" ${(selected||'')===(o==='-'?'':o)?'selected':''}>${o}</option>`).join('');
}

function addEmergencyContact(){ onboardingState.emergency_contacts = [...onboardingState.emergency_contacts, {name:'',relationship:'',contact:''}]; render(); }
function removeEmergencyContact(i){ onboardingState.emergency_contacts.splice(i,1); render(); }
function updateEmergencyContact(i, key, val){ onboardingState.emergency_contacts[i][key] = val; }

async function confirmOnboardingSection(section){
  await saveOnboarding(false);
  try{
    const { data, error } = await apiTry(() => api.post(`/onboarding/${onboardingAppId}/confirm-section`, { section }));
    if(error) throw error;
    onboardingState = data;
    // TP3 has been removed from the candidate-facing flow entirely, but the
    // server-side "all sections confirmed → completed" logic may still
    // expect it — so it's silently confirmed the moment personal_details
    // is, with no UI ever shown for it. This avoids needing to touch
    // rpc_confirm_onboarding_section's internal completion logic.
    if(section === 'personal_details' && !onboardingState.tp3_confirmed){
      const { data: tp3Data, error: tp3Error } = await apiTry(() => api.post(`/onboarding/${onboardingAppId}/confirm-section`, { section: 'tp3' }));
      if(!tp3Error) onboardingState = tp3Data;
    }
    if(onboardingState.status === 'completed') onboardingStep = 'review';
    render();
  } catch(e){ alert('Error: ' + e.message); }
}

function backFromOnboarding(){
  onboardingAppId = null; onboardingState = null; onboardingStep = 'statutory';
  salaryAckChecked = false; salaryAccountManuallyEdited = false;
  goStep('start');
}

function obProgressBar(){
  const visible = ONBOARDING_STEPS.filter(s=>s!=='review');
  const idx = visible.indexOf(onboardingStep);
  return `<div class="progress" style="margin-bottom:22px;">${visible.map((s,i)=>{
    let cls='seg'; if(i<idx) cls+=' done'; if(i===idx) cls+=' active';
    return `<div class="${cls}"></div>`;
  }).join('')}</div>`;
}

function tplOnboarding(){
  if(onboardingStep === 'review') return tplObReview();
  if(onboardingStep === 'preview') return tplObPreview();
  const stepMap = {
    statutory: tplObStatutory,
    spouse_children: tplObSpouseChildren,
    emergency_beneficiary: tplObEmergencyBeneficiary,
    salary: tplObSalary
  };
  return `
    <div class="step-eyebrow">Onboarding</div>
    <h2>Post-Hire Details</h2>
    ${obProgressBar()}
    ${stepMap[onboardingStep]()}
    <div style="text-align:center;margin-top:18px;">
      <button class="link-btn" onclick="saveAndExitOnboarding()">Save &amp; Exit — continue later</button>
    </div>
  `;
}

async function saveAndExitOnboarding(){
  showLoading('Saving your progress...');
  const ok = await saveOnboarding(false);
  hideLoading();
  if(ok) backFromOnboarding();
}

// ---------------------------------------------------------------------------
// STEP 1: Statutory Details
// ---------------------------------------------------------------------------
function tplObStatutory(){
  const o = onboardingState;
  return `
    <div class="step-desc">Congratulations on being hired! Let's get your onboarding details sorted, one section at a time.</div>
    <div class="section-title" style="margin-top:0;">Statutory Details</div>
    <div class="grid">
      <div class="field"><label>EPF No.</label><input type="text" id="ob_epf_no" value="${esc(o.epf_no)}"></div>
      <div class="field"><label>SOCSO No.</label><input type="text" id="ob_socso_no" value="${esc(o.socso_no)}"></div>
    </div>
    <div class="grid">
      <div class="field"><label>Income Tax No.</label><input type="text" id="ob_income_tax_no" value="${esc(o.income_tax_no)}"></div>
      <div class="field"><label>Tax Branch</label><input type="text" id="ob_tax_branch" value="${esc(o.tax_branch)}"></div>
    </div>
    <div class="grid">
      <div class="field"><label>Bank Account No.</label><input type="text" id="ob_bank_account_no" value="${esc(o.bank_account_no)}" oninput="mirrorSalaryAccountNo(this.value)"></div>
      <div class="field"><label>CIDB Green Card No.</label><input type="text" id="ob_cidb_green_card_no" placeholder="e.g. N/A" value="${esc(o.cidb_green_card_no)}"></div>
    </div>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="backFromOnboarding()">← Back to My Applications</button>
      <div class="right"><button class="btn btn-primary" onclick="onboardingGoStep('spouse_children')">Next →</button></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// STEP 2: Spouse + Children
// ---------------------------------------------------------------------------
function tplObSpouseChildren(){
  const o = onboardingState;
  return `
    <div class="section-title" style="margin-top:0;">Spouse Information <span class="opt-tag">(if applicable)</span></div>
    <div class="grid">
      <div class="field"><label>Name (per NRIC)</label><input type="text" id="ob_spouse_name" value="${esc(o.spouse_name)}"></div>
      <div class="field"><label>NRIC No. (without dash)</label><input type="text" id="ob_spouse_nric" value="${esc(o.spouse_nric)}" oninput="handleSpouseNricInput(this.value)"></div>
    </div>
    <div class="grid">
      <div class="field"><label>Date of Birth</label><input type="date" id="ob_spouse_dob" value="${esc(o.spouse_date_of_birth)}"></div>
      <div class="field"><label>Working?</label>
        <div class="radio-row">
          ${['Yes','No'].map(v=>`<label class="radio-opt"><input type="radio" name="ob_spouse_working" value="${v}" ${o.spouse_working===v?'checked':''}> ${v}</label>`).join('')}
        </div>
      </div>
    </div>

    <div class="section-title">Children Below 18 Years Old</div>
    <table class="dyn">
      <thead><tr><th>Name (per NRIC)</th><th>Gender</th><th>NRIC No. (no dash)</th><th>Date of Birth</th><th>Education</th><th>Tax Relief</th><th></th></tr></thead>
      <tbody>
        ${o.children_below_18.map((c,i)=>`
          <tr>
            <td><input type="text" value="${esc(c.name)}" oninput="updateChildBelow18(${i},'name',this.value)"></td>
            <td>
              <select onchange="updateChildBelow18(${i},'gender',this.value)">
                <option value="">—</option>
                <option ${c.gender==='Male'?'selected':''}>Male</option>
                <option ${c.gender==='Female'?'selected':''}>Female</option>
              </select>
            </td>
            <td><input type="text" value="${esc(c.nric)}" oninput="handleChildBelow18NricInput(${i}, this.value)"></td>
            <td><input type="date" id="childBelow18Dob${i}" value="${esc(c.date_of_birth)}" oninput="updateChildBelow18(${i},'date_of_birth',this.value)"></td>
            <td><select onchange="updateChildBelow18(${i},'course_name',this.value)">${childEducationOptionsHtml(c.course_name)}</select></td>
            <td style="text-align:center;"><input type="checkbox" ${c.tax_relief?'checked':''} onchange="updateChildBelow18(${i},'tax_relief',this.checked)"></td>
            <td><button class="remove-x" onclick="removeChildBelow18(${i})">✕</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <button class="add-row-btn" onclick="addChildBelow18()">+ Add child</button>

    <div class="section-title">Children Above 18 Up To 23 <span class="opt-tag">(unmarried &amp; full-time student)</span></div>
    <table class="dyn">
      <thead><tr><th>Name</th><th>Gender</th><th>NRIC No. (no dash)</th><th>Date of Birth</th><th>Education</th><th>Tax Relief</th><th></th></tr></thead>
      <tbody>
        ${o.children_18_to_23.map((c,i)=>`
          <tr>
            <td><input type="text" value="${esc(c.name)}" oninput="updateChild18to23(${i},'name',this.value)"></td>
            <td>
              <select onchange="updateChild18to23(${i},'gender',this.value)">
                <option value="">—</option>
                <option ${c.gender==='Male'?'selected':''}>Male</option>
                <option ${c.gender==='Female'?'selected':''}>Female</option>
              </select>
            </td>
            <td><input type="text" value="${esc(c.nric)}" oninput="handleChild18to23NricInput(${i}, this.value)"></td>
            <td><input type="date" id="child18to23Dob${i}" value="${esc(c.date_of_birth)}" oninput="updateChild18to23(${i},'date_of_birth',this.value)"></td>
            <td><select onchange="updateChild18to23(${i},'course_name',this.value)">${childEducationOptionsHtml(c.course_name)}</select></td>
            <td style="text-align:center;"><input type="checkbox" ${c.tax_relief?'checked':''} onchange="updateChild18to23(${i},'tax_relief',this.checked)"></td>
            <td><button class="remove-x" onclick="removeChild18to23(${i})">✕</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <button class="add-row-btn" onclick="addChild18to23()">+ Add child</button>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="onboardingGoStep('statutory')">← Back</button>
      <div class="right"><button class="btn btn-primary" onclick="onboardingGoStep('emergency_beneficiary')">Next →</button></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// STEP 3: Emergency Contact(s) + Beneficiary + confirm
// ---------------------------------------------------------------------------
function tplObEmergencyBeneficiary(){
  const o = onboardingState;
  return `
    <div class="section-title" style="margin-top:0;">Emergency Contact(s)</div>
    <table class="dyn">
      <thead><tr><th>Name (per NRIC)</th><th>Relationship</th><th>Phone No.</th><th></th></tr></thead>
      <tbody>
        ${o.emergency_contacts.map((c,i)=>`
          <tr>
            <td><input type="text" value="${esc(c.name)}" oninput="updateEmergencyContact(${i},'name',this.value)"></td>
            <td><input type="text" value="${esc(c.relationship)}" oninput="updateEmergencyContact(${i},'relationship',this.value)"></td>
            <td><input type="tel" placeholder="e.g. 012-345 6789" value="${esc(c.contact)}" oninput="updateEmergencyContact(${i},'contact',this.value)"></td>
            <td><button class="remove-x" onclick="removeEmergencyContact(${i})">✕</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <button class="add-row-btn" onclick="addEmergencyContact()">+ Add contact</button>

    <div class="section-title">Beneficiary (Next of Kin)</div>
    <div class="grid g3">
      <div class="field"><label>Name</label><input type="text" id="ob_beneficiary_name" value="${esc(o.beneficiary_name)}"></div>
      <div class="field"><label>Relationship</label><input type="text" id="ob_beneficiary_relationship" value="${esc(o.beneficiary_relationship)}"></div>
      <div class="field"><label>Contact No.</label><input type="tel" placeholder="e.g. 012-345 6789" id="ob_beneficiary_contact" value="${esc(o.beneficiary_contact)}"></div>
    </div>

    <div class="checkbox-row">
      <input type="checkbox" id="confirm_personal_details" ${o.personal_details_confirmed?'checked disabled':''} onchange="if(this.checked) confirmOnboardingSection('personal_details')">
      <label for="confirm_personal_details">I confirm the Statutory Details, Spouse, Children, Emergency Contact and Beneficiary information above is true and correct.</label>
      ${o.personal_details_confirmed ? `<div class="hint" style="margin-left:auto;">Confirmed ${new Date(o.personal_details_confirmed_at).toLocaleString()}</div>` : ''}
    </div>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="onboardingGoStep('spouse_children')">← Back</button>
      <div class="right"><button class="btn btn-primary" ${o.personal_details_confirmed ? '' : 'disabled'} onclick="onboardingGoStep('salary')">Next →</button></div>
    </div>
    ${!o.personal_details_confirmed ? `<p class="hint" style="text-align:right;margin-top:6px;">Please check the confirmation box above to continue.</p>` : ''}
  `;
}

// ---------------------------------------------------------------------------
// STEP 4: Salary Crediting Requisition Form — matches the actual document
// ---------------------------------------------------------------------------
let salaryAckChecked = false; // local-only acknowledgment; the real, final
// confirmation happens on the Review Before Submitting page via
// submitOnboarding() — this checkbox just gates getting to that page, it
// does not itself lock anything in.
let salaryAccountManuallyEdited = false; // once the candidate edits the
// Salary Account No. field directly, stop overwriting it from Bank Account
// No. — same guard pattern as the SOCSO/NRIC auto-mirror above.

function mirrorSalaryAccountNo(val){
  if(!salaryAccountManuallyEdited && onboardingState){
    onboardingState.salary_account_no = val;
  }
}
function handleSalaryAccountManualEdit(val){
  salaryAccountManuallyEdited = true;
  if(onboardingState) onboardingState.salary_account_no = val;
}

function tplObSalary(){
  const o = onboardingState;
  const companies = ['WCT Berhad', 'WCT Construction Sdn Bhd', 'WCT Machinery Sdn Bhd', 'Intraxis Engineering Sdn Bhd'];
  return `
    <div class="section-title" style="margin-top:0;">Salary Crediting Requisition Form</div>
    <p class="step-desc">To: Human Resources Department</p>

    <div class="field">
      <label>Which company are you employed under? <span class="req-star">*</span></label>
      <div class="radio-row" style="flex-direction:column;align-items:flex-start;gap:8px;">
        ${companies.map(c=>`<label class="radio-opt"><input type="radio" name="ob_salary_company" value="${c}" ${o.salary_company===c?'checked':''}> ${c}</label>`).join('')}
      </div>
    </div>

    <p style="font-size:13.5px;">Please be informed that I hereby agree that my salary is to be paid through my bank account as follows:</p>

    <div class="field"><label>Bank</label><input type="text" placeholder="e.g. Maybank" id="ob_salary_bank" value="${esc(o.salary_bank)}"></div>
    <div class="grid">
      <div class="field">
        <label>Account No.</label>
        <input type="text" id="ob_salary_account_no" value="${esc(o.salary_account_no)}" oninput="handleSalaryAccountManualEdit(this.value)">
        <div class="hint">Pre-filled from the Bank Account No. you entered in Statutory Details — edit here if it's different.</div>
      </div>
      <div class="field"><label>IC/Passport No. Submitted During Application</label><input type="text" id="ob_salary_ic" value="${esc(o.salary_ic_submitted || state.nric_new || state.passport_number)}"></div>
    </div>

    <p style="font-size:12.5px;color:var(--ink-soft);">I confirm that the information herein is correct and in order. Should there be any discrepancy in the information, which will lead to possible delay or inability to credit my salaries, it is my sole responsibility.<br><br>
    <em>Saya mengesahkan maklumat tersebut diatas adalah betul dan teratur. Sebarang perbezaan dalam maklumat tersebut, yang mungkin mengakibatkan kelewatan ataupun ketidakmasukan gaji, adalah tanggungjawab saya sendiri.</em></p>

    <div class="checkbox-row">
      <input type="checkbox" id="confirm_salary_crediting" ${salaryAckChecked?'checked':''} onchange="salaryAckChecked=this.checked;render();">
      <label for="confirm_salary_crediting">I confirm the above information is correct.</label>
    </div>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="onboardingGoStep('emergency_beneficiary')">← Back</button>
      <div class="right"><button class="btn btn-primary" ${salaryAckChecked ? '' : 'disabled'} onclick="onboardingGoStep('preview')">Review Before Submitting →</button></div>
    </div>
    ${!salaryAckChecked ? `<p class="hint" style="text-align:right;margin-top:6px;">Please check the confirmation box above to continue.</p>` : ''}
  `;
}

// ---------------------------------------------------------------------------
// REVIEW / PREVIEW — comprehensive, paginated read-only summary of every
// onboarding field. Shared between two places:
//   - 'preview' step: reached from Salary's "Review Before Submitting"
//     button, BEFORE anything is finalized — has an editable "Back to Edit"
//     path and an explicit Submit action.
//   - 'review' step: the final, locked view shown after submission (or when
//     re-opening an already-completed onboarding record).
// ---------------------------------------------------------------------------

function obReviewRow(k,v){ return `<div class="review-row"><div class="k">${k}</div><div class="v">${esc(v)||'—'}</div></div>`; }

function obSummaryPage1Html(o){
  return `
    <div class="review-block">
      <h4>Statutory Details</h4>
      ${obReviewRow('EPF No.', o.epf_no)}
      ${obReviewRow('Income Tax No.', o.income_tax_no)}
      ${obReviewRow('Tax Branch', o.tax_branch)}
      ${obReviewRow('SOCSO No.', o.socso_no)}
      ${obReviewRow('Bank Account No.', o.bank_account_no)}
      ${obReviewRow('CIDB Green Card No.', o.cidb_green_card_no)}
    </div>

    <div class="review-block">
      <h4>Spouse Information</h4>
      ${obReviewRow('Name', o.spouse_name)}
      ${obReviewRow('NRIC', o.spouse_nric)}
      ${obReviewRow('Date of Birth', o.spouse_date_of_birth)}
      ${obReviewRow('Working', o.spouse_working)}
    </div>

    <div class="review-block">
      <h4>Children Below 18</h4>
      ${(o.children_below_18||[]).map(c=>obReviewRow(c.name||'Unnamed', `${c.gender||'—'} · NRIC: ${c.nric||'—'} · DOB: ${c.date_of_birth||'—'} · Education: ${c.course_name||'—'} · Tax Relief: ${c.tax_relief?'Yes':'No'}`)).join('') || obReviewRow('Children','None')}
    </div>

    <div class="review-block">
      <h4>Children 18–23 (Unmarried, Full-Time Student)</h4>
      ${(o.children_18_to_23||[]).map(c=>obReviewRow(c.name||'Unnamed', `${c.gender||'—'} · NRIC: ${c.nric||'—'} · DOB: ${c.date_of_birth||'—'} · Education: ${c.course_name||'—'} · Tax Relief: ${c.tax_relief?'Yes':'No'}`)).join('') || obReviewRow('Children','None')}
    </div>

    <div class="review-block">
      <h4>Emergency Contacts</h4>
      ${(o.emergency_contacts||[]).map(c=>obReviewRow(c.name||'Unnamed', `${c.relationship||'—'} · ${c.contact||'—'}`)).join('') || obReviewRow('Emergency Contacts','None')}
    </div>

    <div class="review-block">
      <h4>Beneficiary (Next of Kin)</h4>
      ${obReviewRow('Name', o.beneficiary_name)}
      ${obReviewRow('Relationship', o.beneficiary_relationship)}
      ${obReviewRow('Contact No.', o.beneficiary_contact)}
    </div>
  `;
}

function obSummaryHtml(o){
  return `
    ${obSummaryPage1Html(o)}
    <div class="review-block">
      <h4>Salary Crediting</h4>
      ${obReviewRow('Company', o.salary_company)}
      ${obReviewRow('Bank', o.salary_bank)}
      ${obReviewRow('Account No.', o.salary_account_no)}
      ${obReviewRow('IC/Passport No. Submitted', o.salary_ic_submitted)}
    </div>
  `;
}

function tplObPreview(){
  const o = onboardingState;
  return `
    <div class="step-eyebrow">Onboarding</div>
    <h2>Review Before Submitting</h2>
    <p class="step-desc">Please check everything below carefully. Once you submit, your onboarding record will be marked complete and HR will be notified — you won't be able to edit it afterward.</p>

    ${obSummaryHtml(o)}

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="onboardingGoStep('salary')">← Back to Edit</button>
      <div class="right"><button class="btn btn-primary" onclick="submitOnboarding()">Submit &amp; Complete Onboarding →</button></div>
    </div>
  `;
}

async function submitOnboarding(){
  const ok = await saveOnboarding(false);
  if(!ok) return;
  try{
    const { data, error } = await apiTry(() => api.post(`/onboarding/${onboardingAppId}/confirm-section`, { section: 'salary_crediting' }));
    if(error) throw error;
    onboardingState = data;
    onboardingStep = 'review';
    render();
    window.scrollTo(0,0);
  } catch(e){ alert('Error: ' + e.message); }
}

function tplObReview(){
  const o = onboardingState;
  const allDone = o.personal_details_confirmed && o.salary_crediting_confirmed;
  return `
    <div class="step-eyebrow">Onboarding</div>
    <h2>Your Onboarding Details</h2>
    ${allDone
      ? `<div class="success-banner">All sections completed.</div>`
      : `<div class="error-banner">Some sections aren't confirmed yet. <span style="text-decoration:underline;cursor:pointer;" onclick="onboardingStep='statutory';render();">Continue filling them in →</span></div>`}

    ${obSummaryHtml(o)}

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="backFromOnboarding()">← Back to My Applications</button>
      <div class="right"><button class="btn btn-ghost" onclick="exportMyOnboardingPdf()">📄 Download as PDF</button></div>
    </div>
  `;
}

// ============================================================================
// EXIT INTERVIEW / OFFBOARDING — digitized "Employee Exit Interview Form".
// Opened via the "Exit Interview Form" button in "Your Previous Applications"
// (shown when status==='offboarding') or via an emailed link of the form
// index.html?exit=<application id> (see boot() below), same pattern as the
// existing ?onboarding=<id> deep link.
//
// Unlike onboarding this is a SINGLE page, not a multi-step wizard — the
// paper form is short enough that splitting it into steps would add
// friction without helping anyone, so it's just Sections A/B/C on one
// screen with a Save Draft + Sign & Submit action. Section D (HR sign-off)
// is admin.html-only — the candidate never sees or edits that part.
// ============================================================================
let exitInterviewAppId = null;
let exitInterviewData = null;
let exitInterviewMode = 'edit'; // 'edit' | 'review' — the review screen is
// the "offboarding details to check before submit" step: a plain read-only
// summary of everything just entered, plus the sign-off checkbox, so the
// candidate sees exactly what HR will see before it's locked in.

// Same fixed reason list/order as admin.html's EXIT_REASONS_LEFT/RIGHT —
// duplicated rather than shared since this project has no build step or
// shared module system between index.html and admin.html.
const EXIT_REASONS_LEFT = ['Compensation (Salary / Benefits)','Better Offer','Career Advancement','Lack of promotional opportunities','Lack of training','Working Hours'];
const EXIT_REASONS_RIGHT = ['Conflict with colleague/superior','Relocation','Retirement','Health','Return to Study','Distance travelled to work'];

async function openExitInterview(applicationId){
  showLoading('Loading your Exit Interview Form...');
  try{
    const { data, error } = await apiTry(() => api.get(`/exit-interviews/${applicationId}`));
    if(error) throw error;
    exitInterviewAppId = applicationId;
    exitInterviewData = data;
    hideLoading();
    goStep('exit-interview');
  } catch(e){
    hideLoading();
    alert('Could not load your Exit Interview Form: ' + e.message);
  }
}

function toggleExitReason(reason, checked){
  const set = new Set(exitInterviewData.reasons || []);
  if(checked) set.add(reason); else set.delete(reason);
  exitInterviewData.reasons = Array.from(set);
}

function backFromExitInterview(){
  exitInterviewAppId = null; exitInterviewData = null; exitInterviewMode = 'edit';
  goStep('start');
}

async function saveExitInterview(showAlert){
  try{
    const patch = {
      position: document.getElementById('ei_position')?.value.trim() || '',
      immediate_superior: document.getElementById('ei_immediate_superior')?.value.trim() || '',
      dept_site: document.getElementById('ei_dept_site')?.value.trim() || '',
      date_joined: document.getElementById('ei_date_joined')?.value || '',
      notice_period: document.getElementById('ei_notice_period')?.value.trim() || '',
      official_last_day: document.getElementById('ei_official_last_day')?.value || '',
      actual_last_day: document.getElementById('ei_actual_last_day')?.value || '',
      reasons: exitInterviewData.reasons || [],
      reasons_other_specify: document.getElementById('ei_reasons_other')?.value.trim() || '',
      comments: document.getElementById('ei_comments')?.value.trim() || ''
    };
    Object.keys(patch).forEach(key => {
      if(patch[key] === '' ) delete patch[key];
    });
    // reasons is always sent (even if empty array) since it's read from
    // state, not the DOM, so it's always accurate regardless of this being
    // a single-page form (no "off-screen field" risk like onboarding's
    // multi-step save has).
    patch.reasons = exitInterviewData.reasons || [];
    const { data, error } = await apiTry(() => api.patch(`/exit-interviews/${exitInterviewAppId}`, { patch }));
    if(error) throw error;
    exitInterviewData = data;
    if(showAlert) alert('Saved.');
    return true;
  } catch(e){ alert('Error saving: ' + e.message); return false; }
}

async function goToExitInterviewReview(){
  const ok = await saveExitInterview(false);
  if(!ok) return;
  exitInterviewMode = 'review';
  render();
  window.scrollTo(0,0);
}

async function submitExitInterview(){
  if(!document.getElementById('ei_sign_confirm').checked){
    alert('Please check the confirmation box to sign and submit.');
    return;
  }
  if(!confirm('Submit and sign your Exit Interview Form? Once signed, you won\'t be able to edit Sections A–C anymore, and HR will be notified to complete their review.')) return;
  try{
    const { data, error } = await apiTry(() => api.post(`/exit-interviews/${exitInterviewAppId}/submit`));
    if(error) throw error;
    exitInterviewData = data;
    exitInterviewMode = 'edit'; // the locked edit view now doubles as the final read-only view
    render();
    window.scrollTo(0,0);
  } catch(e){ alert('Error submitting: ' + e.message); }
}

function eiReviewRow(k,v){ return `<div class="review-row"><div class="k">${k}</div><div class="v">${esc(v)||'—'}</div></div>`; }

function tplExitInterview(){
  if(exitInterviewMode === 'review' && !exitInterviewData.employee_signed) return tplExitInterviewReview();
  return tplExitInterviewEdit();
}

function tplExitInterviewReview(){
  const ei = exitInterviewData;
  const a = myApplications.find(x=>x.id===exitInterviewAppId) || {};
  const reasons = ei.reasons || [];
  return `
    <div class="step-eyebrow">Offboarding</div>
    <h2>Review Your Offboarding Details</h2>
    <p class="step-desc">Please check everything below carefully before signing — this locks Sections A–C and notifies HR.</p>

    <div class="review-block">
      <h4>A: Employee Details</h4>
      ${eiReviewRow('Name (as per NRIC)', a.name_nric)}
      ${eiReviewRow('Position', ei.position)}
      ${eiReviewRow('Immediate Superior', ei.immediate_superior)}
      ${eiReviewRow('Dept/Site', ei.dept_site)}
      ${eiReviewRow('Date Joined', ei.date_joined)}
      ${eiReviewRow('Notice Period', ei.notice_period)}
      ${eiReviewRow('Official Last Day of Employment', ei.official_last_day)}
      ${eiReviewRow('Actual Last Day of Employment', ei.actual_last_day)}
    </div>

    <div class="review-block">
      <h4>B: Reason(s) for Leaving</h4>
      ${eiReviewRow('Selected', reasons.length ? reasons.join(', ') : 'None selected')}
      ${ei.reasons_other_specify ? eiReviewRow('Other, specified', ei.reasons_other_specify) : ''}
    </div>

    <div class="review-block">
      <h4>C: Comments / Suggestions</h4>
      ${eiReviewRow('Comments', ei.comments)}
    </div>

    <div class="checkbox-row" style="background:#FBFAF7;border-color:var(--line);">
      <input type="checkbox" id="ei_sign_confirm">
      <label for="ei_sign_confirm">I confirm the information above is true and correct. Checking this box and submitting acts as my signature — no physical signature is required. Today's date will be recorded automatically.</label>
    </div>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="exitInterviewMode='edit';render();">← Back to Edit</button>
      <div class="right"><button class="btn btn-primary" onclick="submitExitInterview()">Sign &amp; Submit →</button></div>
    </div>
  `;
}

function tplExitInterviewEdit(){
  const ei = exitInterviewData;
  const a = myApplications.find(x=>x.id===exitInterviewAppId) || {};
  const locked = ei.employee_signed;
  const reasonCheckbox = (r) => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;padding:5px 0;">
      <input type="checkbox" ${(ei.reasons||[]).includes(r)?'checked':''} ${locked?'disabled':''} onchange="toggleExitReason('${r.replace(/'/g,"\\'")}', this.checked)">
      ${esc(r)}
    </label>`;

  return `
    <div class="step-eyebrow">Offboarding</div>
    <h2>Employee Exit Interview Form</h2>
    <p class="step-desc">${a.reference_no ? esc(a.reference_no)+' · ' : ''}Private &amp; confidential.</p>

    ${locked ? `<div class="success-banner">Submitted and signed on ${new Date(ei.employee_signed_at).toLocaleString()}. This form is now locked — HR will complete their review next.</div>` : ''}

    <div class="section-title" style="margin-top:0;">A: Employee Details</div>
    <div class="grid">
      <div class="field"><label>Name (as per NRIC)</label><input type="text" value="${esc(a.name_nric)}" disabled></div>
      <div class="field"><label>Position</label><input type="text" id="ei_position" placeholder="e.g. Site Engineer" value="${esc(ei.position)}" ${locked?'disabled':''}></div>
      <div class="field"><label>Immediate Superior</label><input type="text" id="ei_immediate_superior" value="${esc(ei.immediate_superior)}" ${locked?'disabled':''}></div>
      <div class="field"><label>Dept/Site</label><input type="text" id="ei_dept_site" value="${esc(ei.dept_site)}" ${locked?'disabled':''}></div>
      <div class="field"><label>Date Joined</label><input type="date" id="ei_date_joined" value="${ei.date_joined||''}" ${locked?'disabled':''}></div>
      <div class="field"><label>Notice Period</label><input type="text" id="ei_notice_period" value="${esc(ei.notice_period)}" ${locked?'disabled':''}></div>
      <div class="field"><label>Official Last Day of Employment</label><input type="date" id="ei_official_last_day" value="${ei.official_last_day||''}" ${locked?'disabled':''}></div>
      <div class="field"><label>Actual Last Day of Employment</label><input type="date" id="ei_actual_last_day" value="${ei.actual_last_day||''}" ${locked?'disabled':''}></div>
    </div>

    <div class="section-title">B: Please indicate reason(s) below, which contributed to your decision to resign from your current position</div>
    <div class="grid">
      <div>${EXIT_REASONS_LEFT.map(reasonCheckbox).join('')}</div>
      <div>${EXIT_REASONS_RIGHT.map(reasonCheckbox).join('')}</div>
    </div>
    <div class="field" style="margin-top:8px;">
      <label>Others, please specify</label>
      <input type="text" id="ei_reasons_other" value="${esc(ei.reasons_other_specify)}" ${locked?'disabled':''}>
    </div>

    <div class="section-title">C: Employee's Comment(s) / Suggestion(s) for Improvement(s)</div>
    <div class="field">
      <textarea id="ei_comments" rows="4" ${locked?'disabled':''}>${esc(ei.comments)}</textarea>
    </div>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="backFromExitInterview()">← Back to My Applications</button>
      <div class="right">
        ${!locked ? `
          <button class="btn btn-ghost" onclick="saveExitInterview(true)">Save Draft</button>
          <button class="btn btn-primary" onclick="goToExitInterviewReview()">Review Before Submitting →</button>
        ` : `
          <button class="btn btn-primary" onclick="exportMyExitInterviewPdf()">📄 Download as PDF</button>
        `}
      </div>
    </div>
  `;
}


function exportMyExitInterviewPdf(){
  if(!exitInterviewData || !exitInterviewAppId){ alert('No exit interview data loaded.'); return; }
  const a = myApplications.find(x=>x.id===exitInterviewAppId) || {};
  const ei = exitInterviewData;
  const chk = (checked) => `<span style="display:inline-block;width:13px;height:13px;border:1.5px solid #333;margin-right:8px;vertical-align:middle;text-align:center;line-height:11px;font-size:11px;font-weight:bold;">${checked?'✓':''}</span>`;
  const reasons = ei.reasons || [];
  const reasonRow = (label) => `<div style="padding:4px 0;font-size:10.5px;">${chk(reasons.includes(label))}${esc(label)}</div>`;

  const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Exit Interview — ${esc(a.reference_no||'')} — WCT Group</title>
<style>
  @page{ size:A4; margin:14mm; }
  *{box-sizing:border-box;}
  body{font-family:Arial,sans-serif;font-size:10.5px;color:#111;margin:0;line-height:1.5;}
  .outer{border:2px solid #000;}
  .top-bar{display:flex;justify-content:space-between;align-items:center;padding:14px 18px 6px;}
  .top-bar img.logo{height:44px;}
  .top-bar .priv{font-weight:bold;font-size:10px;}
  .form-title{text-align:center;font-size:19px;font-weight:800;margin:2px 0 14px;}
  .section-bar{background:#CFE3F2;font-weight:bold;font-size:10.5px;text-transform:uppercase;padding:6px 14px;border-top:1px solid #000;border-bottom:1px solid #000;}
  .section-body{padding:14px 18px;}
  .kv-row{display:flex;margin-bottom:10px;font-size:10.5px;}
  .kv-row .kv-item{width:50%;display:flex;}
  .kv-row .kv-lbl{width:150px;flex-shrink:0;}
  .kv-row .kv-line{flex:1;border-bottom:1px solid #333;padding-bottom:2px;min-height:14px;}
  .reasons-cols{display:flex;gap:30px;}
  .reasons-cols > div{flex:1;}
  .comments-lines div{border-bottom:1px solid #333;height:22px;margin-bottom:4px;}
  .sig-row{display:flex;gap:60px;margin-top:26px;}
  .sig-block{flex:1;}
  .sig-line{border-bottom:1px solid #333;height:24px;margin-bottom:4px;font-weight:bold;padding-bottom:2px;}
  .sig-cap{font-size:9.5px;color:#333;}
  .print-bar{background:#FFF6D6;border-bottom:2px solid #E0C34C;padding:10px 16px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;}
  .print-bar button{font-weight:bold;font-size:13px;padding:8px 18px;border-radius:6px;border:none;cursor:pointer;background:#000;color:#fff;}
  @media print{ .print-bar{display:none;} }
</style>
</head>
<body>
  <div class="print-bar"><span>Ready — use your browser's print dialog and choose "Save as PDF".</span><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="outer">
    <div class="top-bar">
      <img class="logo" src="${WCT_LOGO_DATA_URI}">
      <div class="priv">PRIVATE &amp; CONFIDENTIAL</div>
    </div>
    <div class="form-title">EMPLOYEE EXIT INTERVIEW FORM</div>

    <div class="section-bar">A: Employee Details</div>
    <div class="section-body">
      <div class="kv-row">
        <div class="kv-item"><span class="kv-lbl">Name (as per NRIC) :</span><span class="kv-line">${fmt(a.name_nric)}</span></div>
        <div class="kv-item"><span class="kv-lbl">Position :</span><span class="kv-line">${fmt(ei.position)}</span></div>
      </div>
      <div class="kv-row">
        <div class="kv-item"><span class="kv-lbl">Immediate Superior :</span><span class="kv-line">${fmt(ei.immediate_superior)}</span></div>
        <div class="kv-item"><span class="kv-lbl">Dept/Site :</span><span class="kv-line">${fmt(ei.dept_site)}</span></div>
      </div>
      <div class="kv-row">
        <div class="kv-item"><span class="kv-lbl">Date Joined :</span><span class="kv-line">${fmtDate(ei.date_joined)}</span></div>
        <div class="kv-item"><span class="kv-lbl">Notice Period :</span><span class="kv-line">${fmt(ei.notice_period)}</span></div>
      </div>
      <div class="kv-row">
        <div class="kv-item"><span class="kv-lbl">Official Last Day of Employment:</span><span class="kv-line">${fmtDate(ei.official_last_day)}</span></div>
        <div class="kv-item"><span class="kv-lbl">Actual Last Day of Employment:</span><span class="kv-line">${fmtDate(ei.actual_last_day)}</span></div>
      </div>
    </div>

    <div class="section-bar">B: Please indicate reason(s) below, which contributed to your decision to resign from your current position</div>
    <div class="section-body">
      <div class="reasons-cols">
        <div>${EXIT_REASONS_LEFT.map(reasonRow).join('')}</div>
        <div>${EXIT_REASONS_RIGHT.map(reasonRow).join('')}</div>
      </div>
      <div style="margin-top:6px;font-size:10.5px;">${chk(!!ei.reasons_other_specify)} Others, please specify</div>
      <div style="border-bottom:1px solid #333;min-height:16px;margin:6px 0 2px 22px;">${fmt(ei.reasons_other_specify)}</div>
    </div>

    <div class="section-bar">C: Employee's Comment(s) / Suggestion(s) for Improvement(s)</div>
    <div class="section-body">
      <div class="comments-lines">
        ${(String(ei.comments||'').match(/.{1,95}(\s|$)/g) || ['']).slice(0,4).map(line=>`<div>${esc(line.trim())}</div>`).join('')}
      </div>
      <div class="sig-row">
        <div class="sig-block">
          <div class="sig-line">${fmt(ei.employee_signed_name)}</div>
          <div class="sig-cap">Employee Signature (digitally confirmed, no wet signature)</div>
        </div>
        <div class="sig-block">
          <div class="sig-line">${ei.employee_signed_at ? fmtDate(ei.employee_signed_at) : '—'}</div>
          <div class="sig-cap">Date</div>
        </div>
      </div>
    </div>

    <div class="section-bar">D: For HRD (HQ) Use Only — To Be Completed by HR Personnel</div>
    <div class="section-body">
      <div class="sig-row">
        <div class="sig-block">
          <div class="sig-line">${ei.hr_signed ? fmt(ei.hr_signed_name) : '—'}</div>
          <div class="sig-cap">Signature (digitally confirmed, no wet signature)</div>
        </div>
        <div class="sig-block">
          <div class="sig-line">${ei.hr_signed ? fmt(ei.hr_signed_name) : '—'}</div>
          <div class="sig-cap">Name in Full</div>
        </div>
        <div class="sig-block">
          <div class="sig-line">${ei.hr_signed ? fmt(ei.hr_signed_position) : '—'}</div>
          <div class="sig-cap">Position</div>
        </div>
        <div class="sig-block">
          <div class="sig-line">${ei.hr_signed ? fmtDate(ei.hr_signed_at) : '—'}</div>
          <div class="sig-cap">Date</div>
        </div>
      </div>
    </div>
  </div>
</body></html>
  `;
  openPrintWindow(html);
}

function handleCitizenChange(val){
  state.citizen = val;
  if(val === 'Non-Malaysian'){
    // NRIC isn't applicable — don't carry over a stale value into a disabled field
    state.nric_new = '';
  }
  render();
}

// Derives Date of Birth from a Malaysian NRIC's first 6 digits (YYMMDD),
// using the standard century pivot: if the two-digit year is greater than
// the current two-digit year, assume 19XX, otherwise 20XX.
function deriveDobFromNric(nric){
  const digits = nric.replace(/[^0-9]/g, '');
  if(digits.length < 6) return null;
  const yy = parseInt(digits.slice(0,2), 10);
  const mm = parseInt(digits.slice(2,4), 10);
  const dd = parseInt(digits.slice(4,6), 10);
  if(mm < 1 || mm > 12 || dd < 1 || dd > 31) return null; // not a plausible date, skip
  const currentYY = new Date().getFullYear() % 100;
  const century = yy > currentYY ? 1900 : 2000;
  const year = century + yy;
  const mmStr = String(mm).padStart(2,'0');
  const ddStr = String(dd).padStart(2,'0');
  return `${year}-${mmStr}-${ddStr}`;
}

function handleNricChange(val){
  state.nric_new = val;

  // 12-digit validation (Malaysian NRIC is always exactly 12 digits, no letters)
  const digits = val.replace(/[^0-9]/g, '');
  const msgEl = document.getElementById('nricValidationMsg');
  if(msgEl){
    if(val.trim() === ''){
      msgEl.innerHTML = '';
    } else if(digits.length !== 12){
      msgEl.innerHTML = `<span style="color:var(--danger);">NRIC must be exactly 12 digits (currently ${digits.length}).</span>`;
    } else {
      msgEl.innerHTML = `<span style="color:var(--ok);">✓ Valid format</span>`;
    }
  }

  // Auto-derive Date of Birth from the NRIC's first 6 digits, once enough
  // digits are entered — the candidate can still override it afterward.
  // Updates fields directly (not via handleDobChange/render) so typing NRIC
  // doesn't lose focus on every keystroke, same fix as the SOCSO mirroring.
  const derivedDob = deriveDobFromNric(val);
  if(derivedDob){
    state.date_of_birth = derivedDob;
    const dob = new Date(derivedDob); const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if(m < 0 || (m===0 && today.getDate() < dob.getDate())) age--;
    state.age = age;
    const dobEl = document.getElementById('dobTextInput');
    const dobPickerEl = document.getElementById('dobPickerInput');
    const ageEl = document.getElementById('ageInput');
    if(dobEl) dobEl.value = formatDobForDisplay(derivedDob);
    if(dobPickerEl) dobPickerEl.value = derivedDob;
    if(ageEl) ageEl.value = age;
  }

  if(!socsoManuallyEdited){
    state.socso_no = val;
    const socsoEl = document.getElementById('socsoInput');
    if(socsoEl) socsoEl.value = val; // update in place, no full re-render (keeps focus while typing)
  }
}

// yyyy-mm-dd (the value type="date" inputs and the backend both use) <->
// dd/mm/yyyy (what candidates actually see and type here).
function formatDobForDisplay(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso||'');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// Lets a candidate type a date of birth as a continuous run of digits
// (e.g. "13042005") without needing to type the slashes themselves — they
// get auto-inserted after the day and month as typed — while typing
// "13/04/2005" directly still works too, since non-digits are stripped
// before reformatting. Only commits to state.date_of_birth (and re-renders,
// via handleDobChange) once a full 8-digit date has been entered AND it's a
// real calendar date, so a half-typed date never gets treated as valid.
function handleDobTextInput(el){
  let digits = el.value.replace(/[^0-9]/g,'').slice(0,8);
  let formatted = digits;
  if(digits.length > 4) formatted = digits.slice(0,2)+'/'+digits.slice(2,4)+'/'+digits.slice(4);
  else if(digits.length > 2) formatted = digits.slice(0,2)+'/'+digits.slice(2);
  el.value = formatted;

  if(digits.length === 8){
    const day = digits.slice(0,2), month = digits.slice(2,4), year = digits.slice(4,8);
    const iso = `${year}-${month}-${day}`;
    const d = new Date(iso);
    const isRealDate = !isNaN(d.getTime()) && d.getUTCDate()===parseInt(day,10) && (d.getUTCMonth()+1)===parseInt(month,10);
    if(isRealDate){
      const picker = document.getElementById('dobPickerInput');
      if(picker) picker.value = iso;
      handleDobChange(iso);
    }
  }
}

// Auto-completes the Correspondence Address (postcode included) from the
// Permanent Address the moment what's been typed so far looks like the
// start of that same address — covers the common case of a candidate whose
// correspondence address IS their permanent one, without them having to
// retype the whole thing. Direct DOM update rather than a full render() so
// typing doesn't lose focus except in the one moment it actually snaps.
function handleCorrespondenceAddressChange(val){
  state.correspondence_address = val;
  const typed = val.trim().replace(/\s+/g,' ').toLowerCase();
  const perm = (state.permanent_address||'').trim().replace(/\s+/g,' ').toLowerCase();
  const alreadyMatches = state.correspondence_address === state.permanent_address;
  if(!alreadyMatches && typed.length >= 5 && perm.length >= typed.length && perm.startsWith(typed)){
    state.correspondence_address = state.permanent_address;
    state.correspondence_postcode = state.permanent_postcode;
    const addrEl = document.getElementById('correspondenceAddressInput');
    const postcodeEl = document.getElementById('correspondencePostcodeInput');
    if(addrEl) addrEl.value = state.correspondence_address;
    if(postcodeEl) postcodeEl.value = state.correspondence_postcode;
  }
}

function handleDobChange(val){
  state.date_of_birth = val;
  if(val){
    const dob = new Date(val); const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if(m < 0 || (m===0 && today.getDate() < dob.getDate())) age--;
    state.age = age;
  }
  render();
}

// ---------------------------------------------------------------------------
// STEP: language ability
// ---------------------------------------------------------------------------
function tplLanguage(){
  const rows = state.language_ability.map((r,i)=>`
    <tr>
      <td><input type="text" value="${esc(r.language)}" oninput="updateArrayField('language_ability',${i},'language',this.value)"></td>
      <td>${selectGFS(r.spoken, `updateArrayField('language_ability',${i},'spoken',this.value)`)}</td>
      <td>${selectGFS(r.written, `updateArrayField('language_ability',${i},'written',this.value)`)}</td>
    </tr>`).join('');
  return `
    <div class="step-eyebrow">Step 2 of 8</div>
    <h2>Language Ability</h2>
    <p class="step-desc">Rate your spoken and written ability for each language.</p>
    <table class="dyn">
      <thead><tr><th>Language / Dialect</th><th>Spoken</th><th>Written</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <button class="add-row-btn" onclick="addLangRow()">+ Add another language</button>
    ${navButtons('personal','education')}
  `;
}
function selectGFS(val, onchangeFn){
  return `<select onchange="${onchangeFn}"><option value="">—</option>${['Good','Fair','Slight'].map(o=>`<option ${val===o?'selected':''}>${o}</option>`).join('')}</select>`;
}
function addLangRow(){ state.language_ability.push({language:'',spoken:'',written:''}); render(); }

// ---------------------------------------------------------------------------
// STEP: education
// ---------------------------------------------------------------------------
function educationOptionsHtml(selected){
  return `<option value="">Select</option>` + HIGHEST_EDUCATION_OPTIONS.map(o=>`<option ${selected===o?'selected':''}>${o}</option>`).join('');
}
// Covers a couple of school-going years past today (for an in-progress/expected
// qualification's "To" year) down to a wide range of birth years back, newest first.
function yearOptionsHtml(selected){
  const now = new Date().getFullYear();
  let opts = `<option value="">Year</option>`;
  for(let y=now+10; y>=now-80; y--){
    opts += `<option value="${y}" ${String(selected)===String(y)?'selected':''}>${y}</option>`;
  }
  return opts;
}

function tplEducation(){
  const rows = state.education.map((r,i)=>`
    <tr>
      <td style="min-width:130px;">
        <select onchange="updateArrayField('education',${i},'type',this.value)">
          ${['School','College/University','Professional Body'].map(o=>`<option ${r.type===o?'selected':''}>${o}</option>`).join('')}
        </select>
      </td>
      <td><input type="text" placeholder="Institution name" value="${esc(r.name)}" oninput="updateArrayField('education',${i},'name',this.value)"></td>
      <td style="width:90px;"><select onchange="updateArrayField('education',${i},'from_year',this.value)">${yearOptionsHtml(r.from_year)}</select></td>
      <td style="width:90px;"><select onchange="updateArrayField('education',${i},'to_year',this.value)">${yearOptionsHtml(r.to_year)}</select></td>
      <td style="min-width:170px;"><select onchange="updateArrayField('education',${i},'qualification',this.value)">${educationOptionsHtml(r.qualification)}</select></td>
      <td style="min-width:150px;"><input type="text" value="${esc(r.course_name)}" oninput="updateArrayField('education',${i},'course_name',this.value)"></td>
      <td><button class="remove-x" onclick="removeRow('education',${i})">✕</button></td>
    </tr>`).join('');
  return `
    <div class="step-eyebrow">Step 3 of 8</div>
    <h2>Education</h2>
    <p class="step-desc">Add your school, college/university, and any professional body memberships.</p>

    <table class="dyn">
      <thead><tr><th>Type</th><th>Institution</th><th>From</th><th>To</th><th>Qualification</th><th>Course Name</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <button class="add-row-btn" onclick="addEduRow()">+ Add education entry</button>
    ${navButtonsValidated('language','experience', validateEducationStep)}
  `;
}
function validateEducationStep(){
  const errs = [];
  state.education.forEach((r,i)=>{
    if(!r.name.trim()) errs.push(`Education entry ${i+1}: please enter the institution name.`);
    if(!r.qualification) errs.push(`Education entry ${i+1}: please select a qualification.`);
  });
  return errs;
}
function addEduRow(){ state.education.push({type:'School',name:'',from_year:'',to_year:'',qualification:'',course_name:''}); render(); }

// ---------------------------------------------------------------------------
// STEP: working experience
// ---------------------------------------------------------------------------
function tplExperience(){
  const rows = state.working_experience.map((r,i)=>`
    <div class="card" style="padding:18px;margin-bottom:14px;border-color:#E4E4E3;">
      <div class="grid">
        <div class="field"><label>Employer Name &amp; Address <span class="req-star">*</span></label><textarea placeholder="e.g. n/a" oninput="updateArrayField('working_experience',${i},'employer',this.value)">${esc(r.employer)}</textarea></div>
        <div class="field"><label>Last Position Held <span class="req-star">*</span></label><input type="text" placeholder="e.g. n/a" value="${esc(r.position)}" oninput="updateArrayField('working_experience',${i},'position',this.value)"></div>
      </div>
      <div class="grid">
        <div class="field"><label>From <span class="req-star">*</span></label><input type="month" value="${esc(r.from)}" oninput="updateArrayField('working_experience',${i},'from',this.value)"></div>
        <div class="field">
          <label>To ${r.is_current ? '' : '<span class="req-star">*</span>'}</label>
          <input type="month" value="${esc(r.to)}" ${r.is_current?'disabled':''} style="${r.is_current?'background:#F0F0EE;color:var(--ink-soft);':''}" oninput="updateArrayField('working_experience',${i},'to',this.value)">
        </div>
      </div>
      <label class="radio-opt" style="margin:-8px 0 14px;"><input type="checkbox" ${r.is_current?'checked':''} onchange="toggleCurrentJob(${i}, this.checked)"> I am currently working here</label>
      <div class="grid">
        <div class="field"><label>Last Drawn Remuneration (Monthly) — RM <span class="req-star">*</span></label><input type="text" placeholder="e.g. 3000 or n/a" value="${esc(r.remuneration)}" oninput="updateArrayField('working_experience',${i},'remuneration',this.value)"></div>
        <div></div>
      </div>
      <div class="field"><label>Job Responsibilities <span class="req-star">*</span></label><textarea placeholder="e.g. n/a" oninput="updateArrayField('working_experience',${i},'responsibilities',this.value)">${esc(r.responsibilities)}</textarea></div>
      <button class="btn-danger-outline" onclick="removeRow('working_experience',${i})">Remove this entry</button>
    </div>`).join('');
  return `
    <div class="step-eyebrow">Step 4 of 8</div>
    <h2>Working Experience / Achievement</h2>
    <p class="step-desc">Please complete this even if a resume/CV is attached. You'll be able to attach your CV in a later step.</p>
    ${rows}
    <button class="add-row-btn" onclick="addExpRow()">+ Add work experience</button>
    ${navButtonsValidated('education','questions', validateExperienceStep)}
  `;
}
function toggleCurrentJob(i, checked){
  state.working_experience[i].is_current = checked;
  if(checked) state.working_experience[i].to = '';
  render();
}
// An entry nobody has touched yet (every field still at its default) is not
// held to the required-field rules below — leaving it blank and clicking
// Next is allowed, same as if the row weren't there. The moment any field on
// the row has something in it, the whole row becomes required; the way out
// at that point is either to finish it or remove the entry.
function isExpRowEmpty(r){
  return !r.employer.trim() && !r.position.trim() && !r.from && !r.to &&
    !r.is_current && !r.remuneration.trim() && !r.responsibilities.trim();
}
function validateExperienceStep(){
  const errs = [];
  state.working_experience.forEach((r,i)=>{
    if(isExpRowEmpty(r)) return;
    if(!r.employer.trim()) errs.push(`Work experience ${i+1}: please enter the employer name and address.`);
    if(!r.position.trim()) errs.push(`Work experience ${i+1}: please enter the last position held.`);
    if(!r.from) errs.push(`Work experience ${i+1}: please provide the "From" month/year.`);
    if(!r.is_current && !r.to) errs.push(`Work experience ${i+1}: please provide the "To" month/year, or tick "I am currently working here".`);
    if(!r.remuneration.trim()) errs.push(`Work experience ${i+1}: please enter the last drawn remuneration.`);
  });
  return errs;
}
function addExpRow(){ state.working_experience.push({employer:'',from:'',to:'',is_current:false,position:'',remuneration:'',responsibilities:''}); render(); }
function removeRow(arr, idx){ state[arr].splice(idx,1); render(); }

// ---------------------------------------------------------------------------
// STEP: employment questions
// ---------------------------------------------------------------------------
function handleResignationChange(val){
  state.resignation_notice_required = val;
  if(val === 'No') state.notice_period = ''; // leave blank per requirement
  render();
}

function validateQuestionsStep(){
  const errs = [];
  if(!state.resignation_notice_required) errs.push('Please answer whether resignation notice is required.');
  if(state.resignation_notice_required==='Yes' && !state.notice_period.trim()) errs.push('Notice period is required when resignation notice is required.');
  if(!state.date_available_to_start) errs.push('Please provide your available start date.');
  if(!state.expected_basic_salary.trim()) errs.push('Please provide your expected basic salary.');
  if(!state.relatives_in_company) errs.push('Please answer the relatives/friends question.');
  if(state.relatives_in_company==='Yes' && !state.relatives_name.trim()) errs.push('Please provide the relative/friend\'s name.');
  if(state.relatives_in_company==='Yes' && !state.relatives_relationship.trim()) errs.push('Please provide your relationship to them.');
  if(!state.referral_person) errs.push('Please answer whether you were referred by anyone.');
  if(state.referral_person==='Yes' && !state.referral_name.trim()) errs.push('Please provide the referral\'s name.');
  if(state.referral_person==='Yes' && !state.referral_department.trim()) errs.push('Please provide the referral\'s department.');
  if(!state.own_transport_motorcar) errs.push('Please answer the motorcar transport question.');
  if(!state.own_transport_motorcycle) errs.push('Please answer the motorcycle transport question.');
  if(!state.willing_based_outside_klang_valley) errs.push('Please answer the outside-Klang-Valley question.');
  if(!state.physical_defects) errs.push('Please answer the physical defects question.');
  if(!state.arrested_convicted) errs.push('Please answer the arrests/convictions question.');
  return errs;
}

function yesNo(field, val, rerenderOnChange){
  const handler = rerenderOnChange
    ? `updateField('${field}','__O__'); render();`
    : `updateField('${field}','__O__')`;
  return `<div class="radio-row">
    ${['Yes','No'].map(o=>`<label class="radio-opt"><input type="radio" name="${field}" ${val===o?'checked':''} onchange="${handler.replace('__O__', o)}"> ${o}</label>`).join('')}
  </div>`;
}
function tplQuestions(){
  return `
    <div class="step-eyebrow">Step 5 of 8</div>
    <h2>Employment Questions</h2>

    <div class="grid">
      <div class="field"><label>Is resignation notice required? <span class="req-star">*</span></label>
        <div class="radio-row">
          ${['Yes','No'].map(o=>`<label class="radio-opt"><input type="radio" name="resignation_notice_required" ${state.resignation_notice_required===o?'checked':''} onchange="handleResignationChange('${o}')"> ${o}</label>`).join('')}
        </div>
      </div>
      ${state.resignation_notice_required==='Yes' ? `
        <div class="field"><label>Notice Period <span class="req-star">*</span></label><input type="text" placeholder="e.g. 1 month" value="${esc(state.notice_period)}" oninput="updateField('notice_period', this.value)"></div>
      ` : `<div></div>`}
    </div>
    <div class="grid">
      <div class="field"><label>Date Available to Start Work <span class="req-star">*</span></label><input type="date" value="${esc(state.date_available_to_start)}" oninput="updateField('date_available_to_start', this.value)"></div>
      <div class="field"><label>Expected Basic Salary (per month) — RM <span class="req-star">*</span></label><input type="text" placeholder="e.g. 4500" value="${esc(state.expected_basic_salary)}" oninput="updateField('expected_basic_salary', this.value)"></div>
    </div>

    <div class="section-title">Additional Questions</div>
    <div class="field"><label>Any relatives or friends working in this Company or its subsidiaries? <span class="req-star">*</span></label>${yesNo('relatives_in_company', state.relatives_in_company, true)}</div>
    ${state.relatives_in_company==='Yes' ? `
      <div class="grid">
        <div class="field"><label>Name <span class="req-star">*</span></label><input type="text" value="${esc(state.relatives_name)}" oninput="updateField('relatives_name', this.value)"></div>
        <div class="field"><label>Relationship <span class="req-star">*</span></label><input type="text" value="${esc(state.relatives_relationship)}" oninput="updateField('relatives_relationship', this.value)"></div>
      </div>` : ''}

    <div class="field"><label>Were you referred by anyone to work at this Company? <span class="req-star">*</span></label>${yesNo('referral_person', state.referral_person, true)}</div>
    ${state.referral_person==='Yes' ? `
      <div class="grid">
        <div class="field"><label>Referral Name <span class="req-star">*</span></label><input type="text" value="${esc(state.referral_name)}" oninput="updateField('referral_name', this.value)"></div>
        <div class="field"><label>Referral Department <span class="req-star">*</span></label><input type="text" value="${esc(state.referral_department)}" oninput="updateField('referral_department', this.value)"></div>
      </div>` : ''}

    <div class="grid">
      <div class="field"><label>Own transport — Motorcar? <span class="req-star">*</span></label>${yesNo('own_transport_motorcar', state.own_transport_motorcar, true)}</div>
      <div class="field"><label>Own transport — Motorcycle? <span class="req-star">*</span></label>${yesNo('own_transport_motorcycle', state.own_transport_motorcycle, true)}</div>
    </div>

    <div class="field"><label>Willing to be based at branches / site offices outside Klang Valley and/or overseas? <span class="req-star">*</span></label>${yesNo('willing_based_outside_klang_valley', state.willing_based_outside_klang_valley, true)}</div>

    <div class="field"><label>Do you have any physical defects, disabilities, or long-term illnesses? <span class="req-star">*</span></label>${yesNo('physical_defects', state.physical_defects, true)}</div>
    ${state.physical_defects==='Yes' ? `<div class="field"><label>Please specify <span class="req-star">*</span></label><textarea oninput="updateField('physical_defects_specify', this.value)">${esc(state.physical_defects_specify)}</textarea></div>` : ''}

    <div class="field"><label>Have you been arrested or convicted of any offence? <span class="req-star">*</span></label>${yesNo('arrested_convicted', state.arrested_convicted, true)}</div>
    ${state.arrested_convicted==='Yes' ? `<div class="field"><label>Please specify <span class="req-star">*</span></label><textarea oninput="updateField('arrested_convicted_specify', this.value)">${esc(state.arrested_convicted_specify)}</textarea></div>` : ''}

    ${navButtonsValidated('experience','referees', validateQuestionsStep)}
  `;
}

// ---------------------------------------------------------------------------
// STEP: referees & declarations
// ---------------------------------------------------------------------------
function tplReferees(){
  return `
    <div class="step-eyebrow">Step 6 of 8</div>
    <h2>Referees &amp; Declarations</h2>
    <p class="step-desc">Please give two referees whose reference can be obtained on your application.</p>

    <div class="grid">
      <fieldset>
        <legend>Referee 1 <span class="req-star">*</span></legend>
        <div class="field"><label>Name <span class="req-star">*</span></label><input type="text" placeholder="e.g. John Tan" value="${esc(state.referee1.name)}" oninput="updateNested(state.referee1,'name',this.value)"></div>
        <div class="field"><label>Designation <span class="req-star">*</span></label><input type="text" placeholder="e.g. Project Manager" value="${esc(state.referee1.designation)}" oninput="updateNested(state.referee1,'designation',this.value)"></div>
        <div class="field"><label>Relationship <span class="req-star">*</span></label><input type="text" placeholder="e.g. Ex-supervisor" value="${esc(state.referee1.relationship)}" oninput="updateNested(state.referee1,'relationship',this.value)"></div>
        <div class="field"><label>Contact No. <span class="req-star">*</span></label><input type="text" placeholder="e.g. 012-345 6789" value="${esc(state.referee1.contact)}" oninput="updateNested(state.referee1,'contact',this.value)"></div>
      </fieldset>
      <fieldset>
        <legend>Referee 2 <span class="req-star">*</span></legend>
        <div class="field"><label>Name <span class="req-star">*</span></label><input type="text" placeholder="e.g. Jane Lim" value="${esc(state.referee2.name)}" oninput="updateNested(state.referee2,'name',this.value)"></div>
        <div class="field"><label>Designation <span class="req-star">*</span></label><input type="text" placeholder="e.g. HR Manager" value="${esc(state.referee2.designation)}" oninput="updateNested(state.referee2,'designation',this.value)"></div>
        <div class="field"><label>Relationship <span class="req-star">*</span></label><input type="text" placeholder="e.g. Colleague" value="${esc(state.referee2.relationship)}" oninput="updateNested(state.referee2,'relationship',this.value)"></div>
        <div class="field"><label>Contact No. <span class="req-star">*</span></label><input type="text" placeholder="e.g. 012-987 6543" value="${esc(state.referee2.contact)}" oninput="updateNested(state.referee2,'contact',this.value)"></div>
      </fieldset>
    </div>

    <div class="section-title">Declarations</div>
    <p style="font-size:13px;line-height:1.6;">(A) I declare that the statement made by me to the foregoing question are true, complete and correct to the best of my knowledge and belief. Permission is given to the Company to make such investigations as and when necessary on the information given above. I understand that my misrepresentation or material omission made herein or on any other documents requested by the Company, will render dismissal or termination of my employment with the Company.</p>

    <div class="field">
      <label>(B) I declare that save and except for the following I am not involved in, a party to nor the subject of any law suits, arbitral proceedings, disciplinary proceedings, criminal inquiry, investigation and/or conviction and/or any other legal or quasi-legal proceedings. <span class="req-star">*</span></label>
      <div class="radio-row">
        <label class="radio-opt"><input type="radio" name="declaration_lawsuit" value="Yes" ${state.declaration_lawsuit==='Yes'?'checked':''} onchange="updateField('declaration_lawsuit', this.value); render();"> Yes</label>
        <label class="radio-opt"><input type="radio" name="declaration_lawsuit" value="No" ${state.declaration_lawsuit==='No'?'checked':''} onchange="updateField('declaration_lawsuit', this.value); render();"> No</label>
      </div>
    </div>
    ${state.declaration_lawsuit==='Yes' ? `<div class="field"><label>Please specify <span class="req-star">*</span></label><textarea oninput="updateField('declaration_lawsuit_specify', this.value)">${esc(state.declaration_lawsuit_specify)}</textarea><div class="hint">Add an attachment on the next step if you need more space.</div></div>` : ''}

    <div class="field">
      <label>(C) I declare that save and except for the following I am not aware of any matter or information that may affect my personal and/or professional public standing or repute or that might adversely affect your consideration of my application for employment. <span class="req-star">*</span></label>
      <div class="radio-row">
        <label class="radio-opt"><input type="radio" name="declaration_other_matters" value="Yes" ${state.declaration_other_matters==='Yes'?'checked':''} onchange="updateField('declaration_other_matters', this.value); render();"> Yes</label>
        <label class="radio-opt"><input type="radio" name="declaration_other_matters" value="No" ${state.declaration_other_matters==='No'?'checked':''} onchange="updateField('declaration_other_matters', this.value); render();"> No</label>
      </div>
    </div>
    ${state.declaration_other_matters==='Yes' ? `<div class="field"><label>Please specify <span class="req-star">*</span></label><textarea oninput="updateField('declaration_other_matters_specify', this.value)">${esc(state.declaration_other_matters_specify)}</textarea><div class="hint">Add an attachment on the next step if you need more space.</div></div>` : ''}

    ${navButtonsValidated('questions','attachments', validateRefereesStep)}
  `;
}
function validateRefereesStep(){
  const errs = [];
  ['referee1','referee2'].forEach((key, idx)=>{
    const r = state[key];
    if(!r.name.trim()) errs.push(`Referee ${idx+1}: please enter a name.`);
    if(!r.designation.trim()) errs.push(`Referee ${idx+1}: please enter a designation.`);
    if(!r.relationship.trim()) errs.push(`Referee ${idx+1}: please enter your relationship to them.`);
    if(!r.contact.trim()) errs.push(`Referee ${idx+1}: please enter a contact number.`);
  });
  if(!state.declaration_lawsuit) errs.push('Please answer declaration (B) — lawsuits, proceedings, and investigations.');
  if(state.declaration_lawsuit==='Yes' && !state.declaration_lawsuit_specify.trim()) errs.push('Please specify the details for declaration (B).');
  if(!state.declaration_other_matters) errs.push('Please answer declaration (C) — matters affecting your standing.');
  if(state.declaration_other_matters==='Yes' && !state.declaration_other_matters_specify.trim()) errs.push('Please specify the details for declaration (C).');
  return errs;
}

// ---------------------------------------------------------------------------
// STEP: attachments & profile picture
// ---------------------------------------------------------------------------
function tplAttachments(){
  const attList = state.attachments.map((a,i)=>{
    const isImg = a.type && a.type.startsWith('image/');
    return `<div class="attach-item">
      <div class="attach-thumb">${isImg ? `<img src="${a.url}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">` : '📄'}</div>
      <div class="attach-name">${esc(a.name)}</div>
      <button class="remove-x" onclick="removeAttachment(${i})">Remove</button>
    </div>`;
  }).join('');

  return `
    <div class="step-eyebrow">Step 7 of 8</div>
    <h2>Attachments &amp; Passport Size Photo</h2>

    <div class="section-title" style="margin-top:0;">Passport Size Photo <span class="req-star">*</span></div>
    ${state.profile_picture_url ? `<img src="${state.profile_picture_url}" class="profile-preview">` : ''}
    <div class="upload-box" onclick="document.getElementById('profileInput').click()">
      <div style="font-size:14px;">📷 Click to ${state.profile_picture_url?'change':'upload'} your passport size photo</div>
      <div class="hint">JPG or PNG, clear passport-style photo recommended</div>
    </div>
    <input type="file" id="profileInput" accept="image/*" style="display:none" onchange="handleProfileUpload(this.files[0])">

    <div class="section-title">Supporting Documents</div>
    <p class="hint">Resume/CV, certificates, testimonials, IC copy (front and back), payslip, etc. Add attachments if you need more space than the form provides.</p>
    <div class="upload-box" onclick="document.getElementById('attachInput').click()">
      <div style="font-size:14px;">📎 Click to add a document</div>
      <div class="hint">PDF, JPG, PNG, or Word files</div>
    </div>
    <input type="file" id="attachInput" style="display:none" onchange="handleAttachmentUpload(this.files[0])">
    <div class="attach-list">${attList}</div>

    ${navButtonsValidated('referees','review', validateAttachmentsStep)}
  `;
}
function validateAttachmentsStep(){
  const errs = [];
  if(!state.profile_picture_url) errs.push('Please upload a passport size photo before continuing — it is required.');
  return errs;
}

// Filename sanitization now happens server-side (backend/src/routes/uploads.js
// sanitizeFilename()) before the blob is actually named — this client-side
// copy no longer needs to produce the real storage key, just something
// reasonable to show while uploading.

async function handleProfileUpload(file){
  if(!file) return;
  showLoading('Uploading passport size photo...');
  try{
    const { data, error } = await apiTry(() => api.upload('/uploads/profile-picture', file));
    if(error) throw error;
    state.profile_picture_url = data.url;
  } catch(e){ alert('Upload failed: '+e.message); }
  hideLoading(); render();
}

async function handleAttachmentUpload(file){
  if(!file) return;
  showLoading('Uploading document...');
  try{
    const { data, error } = await apiTry(() => api.upload('/uploads/attachment', file));
    if(error) throw error;
    state.attachments.push(data);
  } catch(e){ alert('Upload failed: '+e.message); }
  hideLoading(); render();
}
function removeAttachment(i){ state.attachments.splice(i,1); render(); }

// ---------------------------------------------------------------------------
// STEP: review
// ---------------------------------------------------------------------------
function rrow(k,v){ return `<div class="review-row"><div class="k">${k}</div><div class="v">${esc(v)||'—'}</div></div>`; }
function reviewHeader(title, step){ return `<h4>${title} <span class="edit-link" onclick="goStep('${step}')">Edit</span></h4>`; }

function tplReview(){
  return `
    <div class="step-eyebrow">Step 8 of 8</div>
    <h2>Review Your Application</h2>
    <p class="step-desc">Please check every section carefully before proceeding to the consent forms. Reference number: <strong>${state.reference_no}</strong></p>

    <div class="review-block">
      ${reviewHeader('Position', 'start')}
      ${rrow('Business Unit', state.business_unit)}
    </div>

    <div class="review-block">
      ${reviewHeader('Personal Particulars', 'personal')}
      ${rrow('Name', state.name_nric)}
      ${rrow('Alias', state.alias)}
      ${rrow('Permanent Address', state.permanent_address+' '+state.permanent_postcode)}
      ${rrow('Correspondence Address', state.correspondence_address+' '+state.correspondence_postcode)}
      ${rrow('Mobile', state.mobile_phone)}
      ${rrow('Email', state.email)}
      ${rrow('NRIC', state.nric_new)}
      ${rrow('Date of Birth / Age', state.date_of_birth+' / '+state.age)}
      ${rrow('Marital Status', state.marital_status)}
      ${rrow('Race / Bumiputra', state.race+' / '+state.bumiputra)}
    </div>

    <div class="review-block">
      ${reviewHeader('Language Ability', 'language')}
      ${state.language_ability.map(r=>rrow(r.language, `Spoken: ${r.spoken||'—'}, Written: ${r.written||'—'}`)).join('')}
    </div>

    <div class="review-block">
      ${reviewHeader('Education', 'education')}
      ${state.education.map(r=>rrow(r.type, `${r.name} (${r.from_year}–${r.to_year}) — ${r.qualification}${r.course_name?' — '+r.course_name:''}`)).join('')}
    </div>

    <div class="review-block">
      ${reviewHeader('Working Experience', 'experience')}
      ${state.working_experience.map(r=>rrow(r.position||'Position', `${r.employer} (${r.from}–${r.is_current?'Present':r.to})`)).join('')}
    </div>

    <div class="review-block">
      ${reviewHeader('Employment Questions', 'questions')}
      ${rrow('Resignation Notice Required', state.resignation_notice_required)}
      ${rrow('Date Available to Start', state.date_available_to_start)}
      ${rrow('Expected Basic Salary', state.expected_basic_salary)}
      ${rrow('Relatives in Company', state.relatives_in_company==='Yes' ? `Yes — ${state.relatives_name} (${state.relatives_relationship})` : state.relatives_in_company)}
      ${rrow('Referred by Anyone', state.referral_person==='Yes' ? `Yes — ${state.referral_name}, ${state.referral_department}` : state.referral_person)}
      ${rrow('Own Transport (Car / Motorcycle)', `${state.own_transport_motorcar} / ${state.own_transport_motorcycle}`)}
      ${rrow('Willing Outside Klang Valley', state.willing_based_outside_klang_valley)}
      ${rrow('Physical Defects', state.physical_defects)}
      ${rrow('Arrested / Convicted', state.arrested_convicted)}
    </div>

    <div class="review-block">
      ${reviewHeader('Referees & Declarations', 'referees')}
      ${rrow('Referee 1', `${state.referee1.name} — ${state.referee1.designation}`)}
      ${rrow('Referee 2', `${state.referee2.name} — ${state.referee2.designation}`)}
      ${rrow('Declaration (B) — Lawsuits/Proceedings', state.declaration_lawsuit==='Yes' ? `Yes — ${state.declaration_lawsuit_specify}` : state.declaration_lawsuit)}
      ${rrow('Declaration (C) — Other Matters', state.declaration_other_matters==='Yes' ? `Yes — ${state.declaration_other_matters_specify}` : state.declaration_other_matters)}
    </div>

    <div class="review-block">
      ${reviewHeader('Attachments', 'attachments')}
      <div class="file-thumb-row">
        <div class="k" style="width:44%;">Passport Size Photo</div>
        <div class="v" style="width:56%;">
          ${state.profile_picture_url
            ? `<img src="${state.profile_picture_url}" class="profile-thumb-lg">`
            : `<span style="color:var(--danger);">Not uploaded (required)</span>`}
        </div>
      </div>
      ${state.attachments.length ? state.attachments.map(f=>{
        const isImg = f.type && f.type.startsWith('image/');
        return `<div class="file-thumb-row">
          <div class="k" style="width:44%;"></div>
          <div class="v" style="width:56%;display:flex;align-items:center;gap:10px;">
            <span class="file-thumb">${isImg ? `<img src="${f.url}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">` : '📄'}</span>
            <a href="${f.url}" target="_blank">${esc(f.name)}</a>
          </div>
        </div>`;
      }).join('') : rrow('Documents', 'None attached')}
    </div>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="goStep('attachments')">← Back</button>
      <div class="right"><button class="btn btn-primary" onclick="proceedToConsent()">Everything looks correct → Continue to Consent Forms</button></div>
    </div>
  `;
}

async function proceedToConsent(){
  await saveDraft();
  goStep('consent-lang');
}

// ---------------------------------------------------------------------------
// STEP: consent language choice
// ---------------------------------------------------------------------------
function tplConsentLang(){
  return `
    <div class="step-eyebrow">Consent Forms</div>
    <h2>Choose Your Preferred Language</h2>
    <p class="step-desc">The consent and data protection forms are available in Bahasa Malaysia or English. Choose the language you're most comfortable reading.</p>
    <div class="lang-choice">
      <div class="opt ${state.language_choice==='BM'?'selected':''}" onclick="selectLang('BM')">Bahasa Melayu</div>
      <div class="opt ${state.language_choice==='EN'?'selected':''}" onclick="selectLang('EN')">English</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="goStep('review')">← Back</button>
      <div class="right"><button class="btn btn-primary" ${!state.language_choice?'disabled':''} onclick="goStepWithSave('pdpa')">Continue →</button></div>
    </div>
  `;
}
function selectLang(l){ state.language_choice = l; render(); }

// ---------------------------------------------------------------------------
// STEP: PDPA notice
// ---------------------------------------------------------------------------
function tplPdpa(){
  const t = CONSENT_TEXT[state.language_choice || 'EN'];
  return `
    <div class="step-eyebrow">Consent Form</div>
    <h2>${t.pdpaTitle}</h2>
    <div class="consent-doc">${t.pdpaBody}</div>

    <div class="grid">
      <div class="field"><label>${state.language_choice==='BM'?'Nama':'Name'}</label><input type="text" id="pdpaName" value="${esc(state.name_nric)}"></div>
      <div class="field"><label>${state.language_choice==='BM'?'No. K/P':'NRIC No.'}</label><input type="text" id="pdpaNric" value="${esc(state.nric_new)}"></div>
    </div>

    <div class="checkbox-row">
      <input type="checkbox" id="pdpaAgreeBox">
      <label for="pdpaAgreeBox">${t.agreeLabel}</label>
    </div>
    <div id="pdpaErr"></div>

    <div class="btn-row">
      <button class="btn btn-ghost" onclick="goStep('consent-lang')">← Back</button>
      <div class="right"><button class="btn btn-primary" onclick="submitPdpa()">Agree &amp; Continue →</button></div>
    </div>
  `;
}

async function submitPdpa(){
  const box = document.getElementById('pdpaAgreeBox');
  if(!box.checked){
    document.getElementById('pdpaErr').innerHTML = `<div class="error-banner">Please tick the box to confirm your consent before continuing.</div>`;
    return;
  }
  const name = document.getElementById('pdpaName').value.trim();
  const nric = document.getElementById('pdpaNric').value.trim();
  showLoading('Recording your consent...');
  try{
    // The JTS consent letter step has been removed from the candidate-facing
    // flow entirely, but rpc_agree_jts is called silently here (using data
    // already collected earlier in the form, no extra candidate input) in
    // case anything server-side still expects jts_agreed to be true before
    // allowing final submission — same defensive pattern used for TP3.
    const jtsResult = await apiTry(() => api.post(`/applications/${state.id}/consent/jts`, {
      reference_no: state.reference_no, name: state.name_nric, nric: state.nric_new, mobile: state.mobile_phone
    }));
    if(!jtsResult.error) state.jts_agreed = true;

    const { error } = await apiTry(() => api.post(`/applications/${state.id}/consent/pdpa`, {
      reference_no: state.reference_no, name, nric
    }));
    if(error) throw error;
    state.pdpa_agreed = true;
    hideLoading();
    goStep('final');
  } catch(e){ hideLoading(); document.getElementById('pdpaErr').innerHTML = `<div class="error-banner">${e.message}</div>`; }
}

// ---------------------------------------------------------------------------
// STEP: final confirmation & submit
// ---------------------------------------------------------------------------
function tplFinal(){
  return `
    <div class="step-eyebrow">Final Step</div>
    <h2>Submit Your Application</h2>
    <div class="success-banner">Both consent forms have been completed.</div>
    <p class="step-desc">Once submitted, your application will be locked and sent for review. You won't be able to make further edits — if you need to change anything, use the Back button now.</p>
    <div id="finalErr"></div>
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="goStep('pdpa')">← Back</button>
      <div class="right"><button class="btn btn-accent" onclick="finalSubmit()">Submit Application</button></div>
    </div>
  `;
}

async function finalSubmit(){
  showLoading('Submitting your application...');
  try{
    const { error } = await apiTry(() => api.post(`/applications/${state.id}/submit`, { reference_no: state.reference_no }));
    if(error) throw error;
    hideLoading();
    goStep('done');
  } catch(e){
    hideLoading();
    document.getElementById('finalErr').innerHTML = `<div class="error-banner">${e.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// STEP: done
// ---------------------------------------------------------------------------
function tplDone(){
  return `
    <div class="thankyou">
      <div class="step-eyebrow">Application Received</div>
      <h2>Thank you for applying to WCT Group</h2>
      <p class="step-desc">Please keep this reference number for your records — you'll need it for any follow-up.</p>
      <div class="ref-box">${state.reference_no}</div>
      <p class="step-desc">Our HR team will be in touch if your profile matches the role. You may close this page now.</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
        <button class="btn btn-ghost" onclick="exportMyApplicationPdf(state)">📄 Download as PDF</button>
        <button class="btn btn-ghost" onclick="backToMyApplications()">Back to My Applications</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Navigation buttons helper (with autosave on Next)
// ---------------------------------------------------------------------------
function navButtons(backStep, nextStep){
  return `
    <div class="btn-row">
      ${backStep ? `<button class="btn btn-ghost" onclick="goStepWithSave('${backStep}')">← Back</button>` : '<div></div>'}
      <div class="right">
        <button class="btn btn-ghost" onclick="saveAndExit()">Save &amp; Exit</button>
        <button class="btn btn-primary" onclick="goStepWithSave('${nextStep}')">Next →</button>
      </div>
    </div>
  `;
}
async function goStepWithSave(next){ const ok = await saveDraft(); if(ok) goStep(next); }

function navButtonsValidated(backStep, nextStep, validatorFn){
  return `
    <div id="stepErr"></div>
    <div class="btn-row">
      ${backStep ? `<button class="btn btn-ghost" onclick="goStepWithSave('${backStep}')">← Back</button>` : '<div></div>'}
      <div class="right">
        <button class="btn btn-ghost" onclick="saveAndExit()">Save &amp; Exit</button>
        <button class="btn btn-primary" onclick="goStepWithValidation('${nextStep}', ${validatorFn.name})">Next →</button>
      </div>
    </div>
  `;
}
async function goStepWithValidation(next, validatorFn){
  const errs = validatorFn();
  if(errs.length){
    document.getElementById('stepErr').innerHTML = `<div class="error-banner">${errs.join('<br>')}</div>`;
    window.scrollTo(0,0);
    return;
  }
  const ok = await saveDraft();
  if(ok) goStep(next);
}
async function saveAndExit(){
  await saveDraft();
  root.innerHTML = `
    <div class="thankyou">
      <div class="step-eyebrow">Progress Saved</div>
      <h2>Come back anytime</h2>
      <p class="step-desc">Your progress is saved to your account. Just sign back in and you'll find this application waiting for you, exactly where you left off.</p>
      <div class="ref-box">${state.reference_no}</div>
      <button class="btn btn-primary" onclick="backToMyApplications()">Back to My Applications</button>
    </div>`;
}
async function backToMyApplications(){
  showLoading('Loading your applications...');
  await loadMyApplications();
  hideLoading();
  goStep('start');
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function esc(v){
  if(v===null||v===undefined) return '';
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(v){ return (v===null||v===undefined||v==='') ? '—' : esc(String(v)); }
function fmtDate(v){ if(!v) return '—'; try{ return new Date(v).toLocaleDateString('en-GB'); }catch(e){ return esc(v); } }
function fmtDateTime(v){ if(!v) return '—'; try{ return new Date(v).toLocaleString('en-GB'); }catch(e){ return esc(v); } }

// ---------------------------------------------------------------------------
// PDF EXPORT (candidate's own records) — same print-window approach already
// proven in the admin dashboard: build a print-ready HTML page, open it in
// a new tab, and let the browser's own "Print > Save as PDF" do the work.
// No third-party service, no cost.
// ---------------------------------------------------------------------------
function pdfPrintStyles(){
  return `
  @page{ size:A4; margin:18mm 16mm; }
  *{box-sizing:border-box;}
  body{font-family:'Georgia',serif;font-size:11.5px;color:#1a1a1a;margin:0;line-height:1.55;}
  .doc-page + .doc-page{ page-break-before: always; }
  .letterhead{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:20px;}
  .letterhead .brand-row{display:flex;align-items:center;gap:14px;}
  .letterhead img.logo{height:52px;}
  .letterhead h1{font-size:19px;margin:0 0 2px;letter-spacing:.02em;}
  .letterhead .tagline{font-size:10px;color:#666;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:.07em;}
  .letterhead .ref-box{text-align:right;font-family:Arial,sans-serif;}
  .letterhead .ref-box .big{font-size:14px;font-weight:bold;}
  h2.section{font-family:Arial,sans-serif;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#fff;background:#000;padding:5px 10px;margin:20px 0 10px;}
  h2.section:first-of-type{margin-top:0;}
  table{width:100%;border-collapse:collapse;margin-bottom:6px;}
  th{font-family:Arial,sans-serif;font-size:9px;text-transform:uppercase;color:#666;text-align:left;padding:4px 8px;border-bottom:1px solid #ccc;}
  td{padding:5px 8px;font-size:10.5px;vertical-align:top;}
  .kv{display:flex;flex-wrap:wrap;gap:0 24px;}
  .kv .item{width:calc(50% - 12px);padding:3px 0;font-size:11px;}
  .kv .item.full{width:100%;}
  .kv .lbl{font-family:Arial,sans-serif;font-size:8.5px;text-transform:uppercase;color:#888;letter-spacing:.04em;display:block;}
  .footer{margin-top:24px;border-top:1px solid #ccc;padding-top:8px;font-family:Arial,sans-serif;font-size:8.5px;color:#888;display:flex;justify-content:space-between;}
  .legal-body p{margin:0 0 10px;font-size:10.8px;text-align:justify;}
  .confirm-box{border:1px solid #999;padding:12px 14px;margin-top:16px;background:#FAFAF9;}
  .confirm-box .lbl{font-family:Arial,sans-serif;font-size:8.5px;text-transform:uppercase;color:#888;}
  table.form-box{width:100%;border-collapse:collapse;margin-bottom:2px;}
  table.form-box td{border:1px solid #333;padding:5px 8px;font-size:9.5px;vertical-align:top;}
  table.form-box td.lbl{background:#F0F0EE;font-weight:bold;width:32%;}
  table.form-box td.section-hdr{background:#333;color:#fff;font-weight:bold;text-transform:uppercase;font-size:9.5px;letter-spacing:.03em;}
  table.data-table{width:100%;border-collapse:collapse;margin-bottom:8px;}
  table.data-table th,table.data-table td{border:1px solid #999;padding:4px 7px;font-size:9px;text-align:left;}
  table.data-table th{background:#eee;}
  h2.bahagian{font-size:10.5px;background:#000;color:#fff;padding:5px 10px;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.03em;}
  .print-bar{background:#FFF6D6;border-bottom:2px solid #E0C34C;padding:10px 16px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:12.5px;display:flex;justify-content:space-between;align-items:center;}
  .print-bar button{font-family:Arial,sans-serif;font-weight:bold;font-size:13px;padding:8px 18px;border-radius:6px;border:none;cursor:pointer;background:#000;color:#fff;}
  @media print{ .print-bar{display:none;} }
  `;
}
function openPrintWindow(html){
  const win = window.open('', '_blank');
  if(!win){ alert('Please allow pop-ups for this site to generate the PDF.'); return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.onload = () => setTimeout(() => win.print(), 400);
}

function exportMyApplicationPdfById(id){
  const row = myApplications.find(a=>a.id===id);
  if(!row){ alert('Could not find that application.'); return; }
  exportMyApplicationPdf(row);
}
function exportMyApplicationPdf(a){
  const edu = (a.education||[]).map(e=>`<tr><td>${fmt(e.type)}</td><td>${fmt(e.name)}</td><td>${fmt(e.from_year)}–${fmt(e.to_year)}</td><td>${fmt(e.qualification)}</td><td>${fmt(e.course_name)}</td></tr>`).join('')
    || `<tr><td colspan="5" style="text-align:center;color:#999;">No entries provided</td></tr>`;
  const exp = (a.working_experience||[]).map(w=>`
    <tr><td>${fmt(w.employer)}</td><td>${fmt(w.position)}</td><td>${fmt(w.from)}–${w.is_current?'Present':fmt(w.to)}</td><td>${fmt(w.remuneration)}</td></tr>
    ${w.responsibilities ? `<tr><td colspan="4" style="color:#555;font-style:italic;padding-top:0;">${fmt(w.responsibilities)}</td></tr>` : ''}
  `).join('') || `<tr><td colspan="4" style="text-align:center;color:#999;">No entries provided</td></tr>`;
  const lang = (a.language_ability||[]).map(l=>`<tr><td>${fmt(l.language)}</td><td>${fmt(l.spoken)}</td><td>${fmt(l.written)}</td></tr>`).join('')
    || `<tr><td colspan="3" style="text-align:center;color:#999;">No entries provided</td></tr>`;
  const refs = [a.referee1, a.referee2].filter(r => r && r.name);

  const applicationPage = `
  <div class="doc-page">
    <div class="letterhead">
      <div class="brand-row">
        <img class="logo" src="${WCT_LOGO_DATA_URI}">
        <div><h1>WCT Group of Companies</h1><div class="tagline">Employment Application — Candidate Record</div></div>
      </div>
      <div class="ref-box"><div class="big">${esc(a.reference_no||'')}</div><div style="font-size:10px;color:#666;">${fmt(a.business_unit)}</div></div>
    </div>

    <h2 class="section">Personal Particulars</h2>
    <div class="kv">
      <div class="item"><span class="lbl">Name (per NRIC)</span>${fmt(a.name_nric)}</div>
      <div class="item"><span class="lbl">NRIC</span>${fmt(a.nric_new)}</div>
      <div class="item"><span class="lbl">Date of Birth / Age</span>${fmtDate(a.date_of_birth)} / ${fmt(a.age)}</div>
      <div class="item"><span class="lbl">Citizenship / Marital Status</span>${fmt(a.citizen)} / ${fmt(a.marital_status)}</div>
      <div class="item"><span class="lbl">Mobile</span>${fmt(a.mobile_phone)}</div>
      <div class="item"><span class="lbl">Email</span>${fmt(a.email)}</div>
      <div class="item full"><span class="lbl">Permanent Address</span>${fmt(a.permanent_address)} ${fmt(a.permanent_postcode)}</div>
    </div>

    <h2 class="section">Language Ability</h2>
    <table><thead><tr><th>Language</th><th>Spoken</th><th>Written</th></tr></thead><tbody>${lang}</tbody></table>

    <h2 class="section">Education</h2>
    <table><thead><tr><th>Type</th><th>Institution</th><th>Period</th><th>Qualification</th><th>Course Name</th></tr></thead><tbody>${edu}</tbody></table>

    <h2 class="section">Working Experience</h2>
    <table><thead><tr><th>Employer</th><th>Position</th><th>Period</th><th>Last Drawn</th></tr></thead><tbody>${exp}</tbody></table>

    <h2 class="section">Employment Details</h2>
    <div class="kv">
      <div class="item"><span class="lbl">Expected Basic Salary</span>${fmt(a.expected_basic_salary)}</div>
      <div class="item"><span class="lbl">Available to Start</span>${fmtDate(a.date_available_to_start)}</div>
    </div>

    ${refs.length ? `
    <h2 class="section">Referees</h2>
    <div class="kv">
      ${refs.map((r,i)=>`<div class="item"><span class="lbl">Referee ${i+1}</span>${fmt(r.name)} — ${fmt(r.designation)}<br>${fmt(r.relationship)} · ${fmt(r.contact)}</div>`).join('')}
    </div>` : ''}

    <h2 class="section">Declarations</h2>
    <div class="kv">
      <div class="item full"><span class="lbl">(B) Lawsuits/Proceedings</span>${a.declaration_lawsuit==='Yes' ? `Yes — ${fmt(a.declaration_lawsuit_specify)}` : fmt(a.declaration_lawsuit)}</div>
      <div class="item full"><span class="lbl">(C) Other Matters</span>${a.declaration_other_matters==='Yes' ? `Yes — ${fmt(a.declaration_other_matters_specify)}` : fmt(a.declaration_other_matters)}</div>
    </div>

    <div class="footer">
      <span>Reference ${esc(a.reference_no||'')} — Generated ${fmtDateTime(new Date().toISOString())}</span>
      <span>WCT Group Employment Application Portal</span>
    </div>
  </div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(a.reference_no||'Application')} — WCT Group</title><style>${pdfPrintStyles()}</style></head><body>
  <div class="print-bar"><span>Ready — use your browser's print dialog and choose "Save as PDF".</span><button onclick="window.print()">Print / Save as PDF</button></div>
  ${applicationPage}
  </body></html>`;
  openPrintWindow(html);
}

function exportMyOnboardingPdf(){
  if(!onboardingState || !onboardingAppId){ alert('No onboarding data loaded.'); return; }
  const a = myApplications.find(x=>x.id===onboardingAppId) || {};
  const o = onboardingState;
  const chk = (v) => v ? '☑' : '☐';
  const childRowsBelow18 = (o.children_below_18||[]).map(c=>`<tr><td>${fmt(c.name)}</td><td>${fmt(c.gender)}</td><td>${fmt(c.nric)}</td><td>${fmtDate(c.date_of_birth)}</td><td>${fmt(c.course_name)}</td><td style="text-align:center;">${chk(c.tax_relief)}</td></tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:#999;">None</td></tr>`;
  const childRows18to23 = (o.children_18_to_23||[]).map(c=>`<tr><td>${fmt(c.name)}</td><td>${fmt(c.gender)}</td><td>${fmt(c.nric)}</td><td>${fmtDate(c.date_of_birth)}</td><td>${fmt(c.course_name)}</td><td style="text-align:center;">${chk(c.tax_relief)}</td></tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:#999;">None</td></tr>`;
  const emergencyRows = (o.emergency_contacts||[]).map(c=>`<tr><td>${fmt(c.name)}</td><td>${fmt(c.relationship)}</td><td>${fmt(c.contact)}</td></tr>`).join('') || `<tr><td colspan="3" style="text-align:center;color:#999;">None</td></tr>`;

  const page1 = `
  <div class="doc-page">
    <div class="letterhead">
      <div class="brand-row"><img class="logo" src="${WCT_LOGO_DATA_URI}"><div><h1 style="font-size:16px;">Employee Personal Details Form</h1><div class="tagline">Reference: ${esc(a.reference_no||'')} · ${esc(a.name_nric||'')}</div></div></div>
    </div>
    <table class="form-box">
      <tr><td colspan="2" class="section-hdr">Statutory Details</td></tr>
      <tr><td class="lbl">EPF No.</td><td>${fmt(o.epf_no)}</td></tr>
      <tr><td class="lbl">SOCSO No.</td><td>${fmt(o.socso_no)}</td></tr>
      <tr><td class="lbl">Income Tax No.</td><td>${fmt(o.income_tax_no)}</td></tr>
      <tr><td class="lbl">Tax Branch</td><td>${fmt(o.tax_branch)}</td></tr>
      <tr><td class="lbl">Bank Account No.</td><td>${fmt(o.bank_account_no)}</td></tr>
      <tr><td class="lbl">CIDB Green Card No.</td><td>${fmt(o.cidb_green_card_no)}</td></tr>
    </table>
    <table class="form-box">
      <tr><td colspan="2" class="section-hdr">Spouse Information</td></tr>
      <tr><td class="lbl">Name</td><td>${fmt(o.spouse_name)}</td></tr>
      <tr><td class="lbl">NRIC No.</td><td>${fmt(o.spouse_nric)}</td></tr>
      <tr><td class="lbl">Date of Birth</td><td>${fmtDate(o.spouse_date_of_birth)}</td></tr>
      <tr><td class="lbl">Working</td><td>${fmt(o.spouse_working)}</td></tr>
    </table>
    <h2 class="bahagian">Children Below 18</h2>
    <table class="data-table"><thead><tr><th>Name</th><th>Gender</th><th>NRIC</th><th>DOB</th><th>Education</th><th>Tax Relief</th></tr></thead><tbody>${childRowsBelow18}</tbody></table>
    <h2 class="bahagian">Children 18–23</h2>
    <table class="data-table"><thead><tr><th>Name</th><th>Gender</th><th>NRIC</th><th>DOB</th><th>Education</th><th>Tax Relief</th></tr></thead><tbody>${childRows18to23}</tbody></table>
    <h2 class="bahagian">Emergency Contacts</h2>
    <table class="data-table"><thead><tr><th>Name</th><th>Relationship</th><th>Contact</th></tr></thead><tbody>${emergencyRows}</tbody></table>
    <table class="form-box">
      <tr><td colspan="2" class="section-hdr">Beneficiary (Next of Kin)</td></tr>
      <tr><td class="lbl">Name</td><td>${fmt(o.beneficiary_name)}</td></tr>
      <tr><td class="lbl">Relationship</td><td>${fmt(o.beneficiary_relationship)}</td></tr>
      <tr><td class="lbl">Contact No.</td><td>${fmt(o.beneficiary_contact)}</td></tr>
    </table>
  </div>`;

  const page2 = `
  <div class="doc-page">
    <h2 class="bahagian">Salary Crediting Requisition Form</h2>
    <table class="form-box">
      <tr><td class="lbl">Company</td><td>${fmt(o.salary_company)}</td></tr>
      <tr><td class="lbl">Bank</td><td>${fmt(o.salary_bank)}</td></tr>
      <tr><td class="lbl">Account No.</td><td>${fmt(o.salary_account_no)}</td></tr>
      <tr><td class="lbl">IC/Passport No. Submitted</td><td>${fmt(o.salary_ic_submitted)}</td></tr>
    </table>
    <div class="footer">
      <span>Reference ${esc(a.reference_no||'')} — Generated ${fmtDateTime(new Date().toISOString())}</span>
      <span>WCT Group Employment Onboarding Portal</span>
    </div>
  </div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Onboarding — ${esc(a.reference_no||'')} — WCT Group</title><style>${pdfPrintStyles()}</style></head><body>
  <div class="print-bar"><span>Ready — use your browser's print dialog and choose "Save as PDF".</span><button onclick="window.print()">Print / Save as PDF</button></div>
  ${page1}${page2}
  </body></html>`;
  openPrintWindow(html);
}

// ---------------------------------------------------------------------------
// Boot: require sign-in, load the user's profile + saved applications
// ---------------------------------------------------------------------------
function signOut(){
  api.clearSession();
  // Preserve ?bu=... (and anything else in the URL) so someone who signed
  // in via a business-unit-specific link and then signs out doesn't lose
  // that context — without this, logging back in would land on a bare
  // index.html with no business unit, blocking them from starting a new
  // application entirely.
  window.location.href = 'login.html' + window.location.search;
}

(async function boot(){
  if(!api.getToken()){
    window.location.href = 'login.html' + window.location.search;
    return;
  }

  // Blacklist check — must happen before anything else loads. Uses
  // GET /api/blacklist-check (backend/src/routes/applications.js
  // blacklistCheck, mounted at the app level) — a defense-in-depth check
  // independent of the one already enforced at login/register/oauth time,
  // in case an account is blacklisted AFTER a still-valid token was issued.
  try{
    const { data, error } = await apiTry(() => api.get('/blacklist-check'));
    if(error){
      // An expired/invalid token surfaces here as a 401 — treat it the same
      // as "not signed in" rather than silently failing later on.
      if(error.status === 401){
        api.clearSession();
        window.location.href = 'login.html?session_expired=1';
        return;
      }
      throw error;
    }
    if(data.blacklisted){
      api.clearSession();
      window.location.href = 'login.html?blacklisted=1';
      return;
    }
  } catch(e){ console.error('Blacklist check failed:', e); }

  const user = api.getUser();
  currentUser = {
    id: user?.id || '',
    email: user?.email || '',
    name: user?.name || ''
  };

  showLoading('Loading your applications...');
  await loadMyApplications();
  hideLoading();

  // Which business unit this candidate is applying under is now determined
  // by which link they used to reach the portal (e.g. index.html?bu=Mall),
  // rather than a dropdown they pick themselves — different business units
  // share different links, so the right manager gets notified automatically.
  // Left in the URL (not stripped) since this link may be bookmarked/reused.
  linkBusinessUnit = new URLSearchParams(window.location.search).get('bu');

  // A "Complete Your Onboarding" email link lands here as
  // index.html?onboarding=<application id> (carried through the sign-in
  // flow if the candidate wasn't already logged in) — open that
  // application's onboarding form directly instead of the generic
  // application list, so the click actually saves them a step.
  const onboardingId = new URLSearchParams(window.location.search).get('onboarding');
  if(onboardingId){
    // Strip the param so refreshing the page afterward doesn't keep
    // re-opening onboarding every time.
    window.history.replaceState({}, '', window.location.pathname);
    await openOnboarding(onboardingId);
  }

  // Same deep-link pattern as onboarding above, but for the HR-signed Exit
  // Interview notification email: index.html?exit=<application id>.
  const exitId = new URLSearchParams(window.location.search).get('exit');
  if(exitId){
    window.history.replaceState({}, '', window.location.pathname);
    await openExitInterview(exitId);
  }

  render();
})();
