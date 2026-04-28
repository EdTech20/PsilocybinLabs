// Multi-step subscription wizard. Deal-agnostic: pulls deal metadata + the
// templated DOCX from /api/deals/<slug>/* based on the URL slug. The same
// HTML page (index.html) serves every deal portal at /d/<slug>/.

// Detect deal slug from URL (/d/<slug>/...).
const DEAL_SLUG = (() => {
  const m = /^\/d\/([^/]+)/.exec(location.pathname);
  return m ? decodeURIComponent(m[1]) : 'psilocybinlabs';
})();
let DEAL = null;        // populated by loadDealConfig()
let TEMPLATE_BYTES = null; // populated by loadTemplate()

const STEPS = [
  { id: 1, label: 'Identity', sub: 'Subscriber details', icon: 'ph-user' },
  { id: 2, label: 'Address & residency', sub: 'Jurisdiction & address', icon: 'ph-map-pin' },
  { id: 3, label: 'Subscription', sub: 'Shares & pricing', icon: 'ph-briefcase' },
  { id: 4, label: 'Prospectus exemption', sub: 'Legal qualification', icon: 'ph-scales' },
  { id: 5, label: 'Certify & sign', sub: 'Review & execute', icon: 'ph-signature' },
];



// Schedule A accredited investor categories (NI 45-106). Labels abbreviated
// for UI — full definitions appear in the generated Schedule A.
const AI_CATEGORIES = [
  { code: 'a', label: 'Canadian financial institution or authorized foreign bank (Sched III, Bank Act).' },
  { code: 'b', label: 'Business Development Bank of Canada.' },
  { code: 'c', label: 'Wholly-owned subsidiary of (a) or (b).' },
  { code: 'd', label: 'Registered adviser or dealer under Canadian securities legislation.' },
  { code: 'e', label: 'Registered / formerly registered representative of a person in (d).' },
  { code: 'e1', label: 'Formerly registered individual (except limited market dealer rep in ON/NL).' },
  { code: 'f', label: 'Government of Canada or a jurisdiction / crown corporation.' },
  { code: 'g', label: 'Municipality, public board or commission in Canada.' },
  { code: 'h', label: 'Foreign national, federal, state, provincial, territorial or municipal government.' },
  { code: 'i', label: 'Regulated pension fund (OSFI or provincial).' },
  { code: 'j', label: 'Individual, alone or with spouse, owning financial assets > $1,000,000 (net of related liabilities).', triggersF9: true },
  { code: 'j1', label: 'Individual owning financial assets > $5,000,000 (net of related liabilities).', triggersF9: true },
  { code: 'k', label: 'Individual net income > $200,000 (or $300,000 with spouse) in each of the last 2 years.', triggersF9: true },
  { code: 'l', label: 'Individual, alone or with spouse, with net assets ≥ $5,000,000.', triggersF9: true },
  { code: 'm', label: 'Non-individual entity with net assets ≥ $5,000,000.' },
  { code: 'n', label: 'Investment fund that distributes only to AI / minimum-amount investors.' },
  { code: 'o', label: 'Investment fund distributed under a Canadian prospectus.' },
  { code: 'p', label: 'Registered trust company / corporation acting for a fully managed account.' },
  { code: 'q', label: 'Registered adviser managing a fully managed account.' },
  { code: 'r', label: 'Registered charity that obtained advice from an eligibility adviser.' },
  { code: 's', label: 'Entity organized in a foreign jurisdiction analogous to (a)–(d) or (i).' },
  { code: 't', label: 'Entity in which all owners of interests are accredited investors.' },
  { code: 'u', label: 'Investment fund advised by a registered or exempt adviser.' },
  { code: 'v', label: 'Person recognized / designated by the securities regulatory authority as AI.' },
  { code: 'w', label: 'Trust established by an AI for the benefit of family members.' },
];

const US_AI_CATEGORIES = [
  { code: '1', label: 'Bank, broker-dealer, insurance co., registered investment co., SBIC, or qualifying employee benefit plan.' },
  { code: '2', label: 'Private business development company (Sec. 202(a)(22), Investment Advisers Act).' },
  { code: '3', label: '501(c)(3), corporation, business trust or partnership with total assets > US$5,000,000.' },
  { code: '4', label: 'Trust with total assets > US$5,000,000 whose purchase is directed by a sophisticated person.' },
  { code: '5', label: 'Natural person with individual or joint net worth > US$1,000,000 (excluding primary residence).' },
  { code: '6', label: 'Natural person with income > US$200,000 (or US$300,000 joint) in each of last 2 years, expected to continue.' },
  { code: '7', label: 'Director or executive officer of the Issuer.' },
  { code: '8', label: 'Entity in which all equity owners are accredited investors.' },
];

/* ---------- State ---------- */
let currentStep = 1;

/* ---------- DOM helpers ---------- */
const form = document.getElementById('subscription-form');
const status = document.getElementById('status');

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function showStatus(msg, cls = 'ok') {
  status.className = 'status ' + cls;
  status.textContent = msg;
  status.hidden = false;
  status.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function clearStatus() { status.hidden = true; status.textContent = ''; }

/* ---------- Render stepper ---------- */
function renderStepper() {
  const ol = document.createElement('ol');
  STEPS.forEach(({ id, label, sub, icon }) => {
    const li = document.createElement('li');
    if (id === currentStep) li.classList.add('active');
    if (id < currentStep) li.classList.add('done');
    
    // Render icon and text wrapper
    li.innerHTML = `
      <div class="step-icon"><i class="ph-bold ${icon}"></i></div>
      <div class="step-text">
        <div class="step-title">${label}</div>
        <div class="step-sub">${sub}</div>
      </div>
    `;
    ol.appendChild(li);
  });
  $('#stepper').innerHTML = '';
  $('#stepper').appendChild(ol);
}

/* ---------- Custom Select Component ---------- */
function initCustomSelect(select) {
  if (select.dataset.customized) return;
  select.dataset.customized = 'true';
  select.hidden = true;

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select';
  wrapper.tabIndex = 0;

  const trigger = document.createElement('div');
  trigger.className = 'custom-select-trigger';
  
  const valueDisplay = document.createElement('span');
  valueDisplay.className = 'custom-select-value';
  valueDisplay.innerHTML = select.options[select.selectedIndex]?.innerHTML || '— select —';
  
  const icon = document.createElement('i');
  icon.className = 'ph-bold ph-caret-down';
  
  trigger.appendChild(valueDisplay);
  trigger.appendChild(icon);

  const dropdown = document.createElement('div');
  dropdown.className = 'custom-select-dropdown';
  
  const searchContainer = document.createElement('div');
  searchContainer.className = 'custom-select-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search...';
  searchContainer.appendChild(searchInput);
  
  const optionsContainer = document.createElement('div');
  optionsContainer.className = 'custom-select-options';

  dropdown.appendChild(searchContainer);
  dropdown.appendChild(optionsContainer);
  
  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);
  
  select.parentNode.insertBefore(wrapper, select.nextSibling);

  let isOpen = false;

  function renderOptions(filter = '') {
    optionsContainer.innerHTML = '';
    const filterLower = filter.toLowerCase();
    Array.from(select.options).forEach((opt, idx) => {
      if (opt.value === '' && filter !== '') return;
      if (filter && !opt.text.toLowerCase().includes(filterLower)) return;
      
      const optionEl = document.createElement('div');
      optionEl.className = 'custom-select-option' + (select.selectedIndex === idx ? ' selected' : '');
      optionEl.innerHTML = opt.innerHTML;
      optionEl.dataset.value = opt.value;
      optionEl.addEventListener('click', (e) => {
        e.stopPropagation();
        select.selectedIndex = idx;
        valueDisplay.innerHTML = opt.innerHTML;
        closeDropdown();
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('input', { bubbles: true }));
      });
      optionsContainer.appendChild(optionEl);
    });
    if (optionsContainer.children.length === 0) {
      optionsContainer.innerHTML = '<div class="custom-select-empty">No results found</div>';
    }
  }

  function toggleDropdown() {
    if (isOpen) closeDropdown();
    else openDropdown();
  }

  function openDropdown() {
    isOpen = true;
    wrapper.classList.add('open');
    renderOptions();
    searchInput.value = '';
    setTimeout(() => searchInput.focus(), 50);
  }

  function closeDropdown() {
    isOpen = false;
    wrapper.classList.remove('open');
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    toggleDropdown();
  });
  
  wrapper.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleDropdown();
    }
  });

  select.addEventListener('click', (e) => {
    e.preventDefault();
    if (!isOpen) openDropdown();
  });
  
  searchInput.addEventListener('input', (e) => {
    renderOptions(e.target.value);
  });
  
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDropdown();
      wrapper.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target === select) return;
    if (!wrapper.contains(e.target)) closeDropdown();
  });

  select.addEventListener('change', () => {
    valueDisplay.innerHTML = select.options[select.selectedIndex]?.innerHTML || '— select —';
  });

  const observer = new MutationObserver(() => {
    valueDisplay.innerHTML = select.options[select.selectedIndex]?.innerHTML || '— select —';
    if (isOpen) renderOptions(searchInput.value);
  });
  observer.observe(select, { childList: true });
}

function applyCustomSelects() {
  const targets = [
    document.getElementById('subscriberCountry'),
    document.getElementById('subscriberProvince'),
    document.getElementById('subscriberCity'),
    document.getElementById('jurisdiction'),
    document.querySelector('select[name="entityType"]')
  ];
  targets.forEach(el => {
    if (el) initCustomSelect(el);
  });
}

/* ---------- Populate dynamic fields ---------- */
async function populateCountries() {
  const sel = $('#subscriberCountry');
  try {
    const res = await fetch('https://countriesnow.space/api/v0.1/countries/info?returns=unicodeFlag');
    const data = await res.json();
    if (data && data.data) {
      sel.innerHTML = '<option value="">— select country —</option>' +
        data.data.map(c => `<option value="${escapeHtml(c.name)}">${c.unicodeFlag || ''} ${escapeHtml(c.name)}</option>`).join('');
    }
  } catch (err) {
    console.error('Failed to load countries', err);
  }
}

async function loadStates(countryName) {
  const provSel = $('#subscriberProvince');
  const jurSel = $('#jurisdiction');
  const citySel = $('#subscriberCity');
  
  if (!countryName) {
    provSel.innerHTML = '<option value="">— select state/province —</option>';
    jurSel.innerHTML = '<option value="">— select jurisdiction —</option>';
    citySel.innerHTML = '<option value="">— select city —</option>';
    return;
  }
  
  try {
    const res = await fetch('https://countriesnow.space/api/v0.1/countries/states', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: countryName })
    });
    const data = await res.json();
    const states = data?.data?.states || [];
    
    const stateOptions = '<option value="">— select —</option>' +
      states.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('');
      
    provSel.innerHTML = stateOptions;
    jurSel.innerHTML = stateOptions;
    citySel.innerHTML = '<option value="">— select city —</option>';
  } catch (err) {
    console.error('Failed to load states', err);
  }
}

async function loadCities(countryName, stateName) {
  const citySel = $('#subscriberCity');
  if (!countryName || !stateName) {
    citySel.innerHTML = '<option value="">— select city —</option>';
    return;
  }
  
  try {
    const res = await fetch('https://countriesnow.space/api/v0.1/countries/state/cities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: countryName, state: stateName })
    });
    const data = await res.json();
    const cities = data?.data || [];
    
    citySel.innerHTML = '<option value="">— select city —</option>' +
      cities.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  } catch (err) {
    console.error('Failed to load cities', err);
  }
}
function populateAI() {
  $('#aiCategoriesList').innerHTML = AI_CATEGORIES.map((c) => `
    <label class="ai-item">
      <input type="checkbox" name="aiCategories" value="${c.code}" />
      <span class="ai-code">(${c.code})</span>
      <span>${c.label}${c.triggersF9 ? ' <em style="color:#c23b3b">(triggers Form 45-106F9)</em>' : ''}</span>
    </label>`).join('');
  $('#usAiCategoriesList').innerHTML = US_AI_CATEGORIES.map((c) => `
    <label class="ai-item">
      <input type="checkbox" name="usAiCategories" value="${c.code}" />
      <span class="ai-code">(${c.code})</span>
      <span>${c.label}</span>
    </label>`).join('');
}

/* ---------- Step navigation ---------- */
function showStep(n) {
  currentStep = n;
  $$('.step').forEach((s) => {
    s.hidden = Number(s.dataset.step) !== n;
  });
  $('[data-nav=back]').hidden = n === 1;
  const nextBtn = $('[data-nav=next]');
  nextBtn.hidden = n === STEPS.length;
  nextBtn.textContent = n === STEPS.length - 1 ? 'Review →' : 'Next';
  if (n === STEPS.length) renderReview();
  renderStepper();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function validateStep(n) {
  const step = $(`.step[data-step="${n}"]`);
  const required = $$('input[required], select[required]', step).filter((el) => !el.disabled && !el.closest('[hidden]'));
  for (const el of required) {
    if (!el.value || (el.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value))) {
      el.focus();
      showStatus('Please complete: ' + (el.previousElementSibling?.textContent || el.name), 'err');
      return false;
    }
  }
  if (n === 3) {
    const registrant = form.querySelector('input[name=registrantStatus]:checked');
    if (!registrant) { showStatus('Select your registrant status.', 'err'); return false; }
    const disc = form.querySelector('input[name=hasDisclosedPrincipal]:checked')?.value;
    if (disc === 'yes') {
      if (!form.disclosedPrincipalName.value || !form.disclosedPrincipalAddress.value) {
        showStatus('Complete the disclosed principal details.', 'err'); return false;
      }
    }
  }
  if (n === 4) {
    const ex = form.querySelector('input[name=exemptionCategory]:checked')?.value;
    if (!ex) { showStatus('Select a prospectus exemption.', 'err'); return false; }
    if (ex === 'accredited_investor_ca') {
      const chosen = $$('input[name=aiCategories]:checked');
      if (chosen.length === 0) { showStatus('Select at least one AI category.', 'err'); return false; }
    }
    if (ex === 'ffba_ca') {
      const juris = form.jurisdictionOfResidence.value;
      if (juris === 'Ontario') { showStatus('FFBA exemption is not available in Ontario.', 'err'); return false; }
      if (!form.ffbaCategory.value && !form.querySelector('input[name=ffbaCategory]:checked')) {
        showStatus('Select an FFBA relationship category.', 'err'); return false;
      }
      if (!form.ffbaRelationshipName.value) {
        showStatus('Provide the relationship contact name.', 'err'); return false;
      }
    }
    if (ex === 'us_accredited') {
      const chosen = $$('input[name=usAiCategories]:checked');
      if (chosen.length === 0) { showStatus('Select at least one U.S. AI category.', 'err'); return false; }
    }
  }
  clearStatus();
  return true;
}

/* ---------- Conditional UI ---------- */
function wireConditionals() {
  $('#subscriberCountry').addEventListener('change', async (e) => {
    await loadStates(e.target.value);
  });

  $('#subscriberProvince').addEventListener('change', async (e) => {
    const country = $('#subscriberCountry').value;
    await loadCities(country, e.target.value);
  });

  const entitySel = form.entityType;
  const entityFields = $$('.entity-only');
  entitySel.addEventListener('change', () => {
    const isEntity = entitySel.value === 'entity';
    entityFields.forEach((f) => { f.hidden = !isEntity; f.querySelectorAll('input').forEach((i) => { i.required = isEntity; }); });
  });

  // Auto-calc aggregate price - reads DEAL.unitPrice + currency at render time
  form.numberOfShares.addEventListener('input', () => {
    const n = Number(form.numberOfShares.value) || 0;
    const price = (DEAL && Number(DEAL.unitPrice)) || 0;
    const cur = (DEAL && DEAL.currency) || 'CAD';
    form.aggregatePrice.value = (n * price).toLocaleString('en-CA', { style: 'currency', currency: cur });
    renderSummary();
  });

  // Disclosed principal toggle
  form.querySelectorAll('input[name=hasDisclosedPrincipal]').forEach((r) => {
    r.addEventListener('change', () => {
      const show = form.querySelector('input[name=hasDisclosedPrincipal]:checked').value === 'yes';
      const panel = $('.principal-fields');
      if (show) {
        panel.hidden = false;
        // Force animation replay
        panel.style.animation = 'none';
        panel.offsetHeight; // reflow
        panel.style.animation = '';
      } else {
        panel.hidden = true;
      }
    });
  });

  // Exemption panels
  form.querySelectorAll('input[name=exemptionCategory]').forEach((r) => {
    r.addEventListener('change', () => {
      const v = r.value;
      $('#aiCategories').hidden = v !== 'accredited_investor_ca';
      $('#ffbaFields').hidden = v !== 'ffba_ca';
      $('#usAiCategories').hidden = v !== 'us_accredited';
    });
  });

  // Default execution date = today
  form.executionDate.valueAsDate = new Date();

  // Live summary + review
  form.addEventListener('input', () => {
    renderSummary();
    saveToLocalStorage();
  });
}

/* ---------- Local Storage ---------- */
const LS_KEY = 'autosubdoc_form_state';

function saveToLocalStorage() {
  const data = collect();
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}

async function restoreFromLocalStorage() {
  const saved = localStorage.getItem(LS_KEY);
  if (!saved) return;
  try {
    const data = JSON.parse(saved);
    for (const el of form.elements) {
      if (!el.name) continue;
      const val = data[el.name];
      if (val === undefined) continue;

      if (el.type === 'checkbox') {
        if (el.name === 'aiCategories' || el.name === 'usAiCategories') {
          if (Array.isArray(val) && val.includes(el.value)) {
            el.checked = true;
          }
        } else {
          el.checked = !!val;
        }
      } else if (el.type === 'radio') {
        if (el.value === String(val)) {
          el.checked = true;
        }
      } else {
        el.value = val;
      }
    }
    // Re-trigger conditionals
    if (form.entityType) form.entityType.dispatchEvent(new Event('change'));
    form.querySelectorAll('input[name=hasDisclosedPrincipal]:checked').forEach(r => r.dispatchEvent(new Event('change')));
    form.querySelectorAll('input[name=exemptionCategory]:checked').forEach(r => r.dispatchEvent(new Event('change')));
    if (form.numberOfShares) form.numberOfShares.dispatchEvent(new Event('input'));

    if (data.subscriberCountry) {
      await loadStates(data.subscriberCountry);
      if (data.subscriberProvince) {
        form.subscriberProvince.value = data.subscriberProvince;
        form.subscriberProvince.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (data.jurisdictionOfResidence) {
        form.jurisdictionOfResidence.value = data.jurisdictionOfResidence;
        form.jurisdictionOfResidence.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (data.subscriberProvince) {
        await loadCities(data.subscriberCountry, data.subscriberProvince);
        if (data.subscriberCity) {
          form.subscriberCity.value = data.subscriberCity;
          form.subscriberCity.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
  } catch (e) {
    console.error('Failed to restore from local storage', e);
  }
}

/* ---------- Summary & review ---------- */
function collect() {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      if (el.name === 'aiCategories' || el.name === 'usAiCategories') {
        if (!data[el.name]) data[el.name] = [];
        if (el.checked) data[el.name].push(el.value);
      } else {
        data[el.name] = el.checked;
      }
    } else if (el.type === 'radio') {
      if (el.checked) data[el.name] = el.value;
    } else {
      data[el.name] = el.value;
    }
  }
  data.certifications = {
    readAndUnderstood: !!data.certRead,
    authorized: !!data.certAuth,
    ownAccount: !!data.certOwnAccount,
    notProceedsOfCrime: !!data.certPoCrime,
    riskAcknowledged: !!data.certRisk,
    advisedIndependently: !!data.certAdvice,
    consentToElectronicDelivery: !!data.certElectronic,
  };
  data.form45106F9Acknowledged = !!data.certRisk; // risk ack doubles as F9 acknowledgement
  return data;
}

function renderSummary() {
  const d = collect();
  const list = $('#summaryList');
  const shares = Number(d.numberOfShares) || 0;
  const rows = [
    ['Subscriber', d.subscriberName],
    ['Type', d.entityType],
    ['Jurisdiction', d.jurisdictionOfResidence],
    ['Shares', shares ? shares.toLocaleString() : ''],
    [`Aggregate (${(DEAL && DEAL.currency) || 'CAD'})`, shares ? (shares * ((DEAL && Number(DEAL.unitPrice)) || 0)).toLocaleString('en-CA', { style: 'currency', currency: (DEAL && DEAL.currency) || 'CAD' }) : ''],
    ['Exemption', {
      accredited_investor_ca: 'Canadian AI',
      ffba_ca: 'Family/Friends/BA',
      us_accredited: 'U.S. AI',
    }[d.exemptionCategory] || ''],
  ];
  list.innerHTML = rows.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

function renderReview() {
  const d = collect();
  const issues = [];
  if (d.exemptionCategory === 'ffba_ca' && d.jurisdictionOfResidence === 'Ontario')
    issues.push('FFBA exemption is NOT available in Ontario.');
  const individualF9Triggers = ['j', 'j1', 'k', 'l'];
  if (d.entityType === 'individual' && Array.isArray(d.aiCategories)
      && d.aiCategories.some((c) => individualF9Triggers.includes(c))) {
    issues.push('Form 45-106F9 will be appended (required for individual AI (j)(j.1)(k)(l)).');
  }
  if (d.jurisdictionOfResidence === 'Saskatchewan' && d.exemptionCategory === 'ffba_ca') {
    issues.push('Schedule B1 (Saskatchewan risk acknowledgement) will be required.');
  }

  const html = `
    <h4>Review</h4>
    <ul>
      <li><strong>Subscriber:</strong> ${escapeHtml(d.subscriberName || '—')} (${escapeHtml(d.entityType || '—')})</li>
      <li><strong>Email / phone:</strong> ${escapeHtml(d.subscriberEmail || '—')} · ${escapeHtml(d.subscriberPhone || '—')}</li>
      <li><strong>Jurisdiction:</strong> ${escapeHtml(d.jurisdictionOfResidence || '—')}</li>
      <li><strong>Units × price:</strong> ${Number(d.numberOfShares || 0).toLocaleString()} × ${((DEAL && DEAL.currency)||'CAD')} $${((DEAL && Number(DEAL.unitPrice))||0).toFixed(2)} = ${(Number(d.numberOfShares||0)*((DEAL && Number(DEAL.unitPrice))||0)).toLocaleString('en-CA',{style:'currency',currency:(DEAL && DEAL.currency) || 'CAD'})}</li>
      <li><strong>Exemption:</strong> ${escapeHtml(d.exemptionCategory || '—')}${d.aiCategories?.length ? ' · categories: ' + d.aiCategories.join(', ') : ''}${d.usAiCategories?.length ? ' · US categories: ' + d.usAiCategories.join(', ') : ''}</li>
    </ul>
    ${issues.length ? '<h4>Flags</h4><ul>' + issues.map(i => '<li>' + escapeHtml(i) + '</li>').join('') + '</ul>' : ''}
  `;
  $('#reviewBox').innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* ---------- DOCX generation (client-side) ---------- */
function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Derive initials from the typed signature / subscriber name.
// "Jane Demo" -> "JD", "Acme Holdings Ltd." -> "AL".
function initialsOf(name) {
  if (!name) return '';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AI_CODES = ['a','b','c','d','e','e1','f','g','h','i','j','j1','k','l','m','n','o','p','q','r','s','t','u','v','w'];
const AION_CODES = ['a','b','c','d','e','f','g','h','i'];
const FFBA_CODES = ['a','b','c','d','e','f','g','h','i'];

function buildPlaceholders(p) {
  const shares = Number(p.numberOfShares) || 0;
  const unitPrice = (DEAL && Number(DEAL.unitPrice)) || 0.5;
  const price = shares * unitPrice;
  const addr = [
    p.subscriberAddressLine1, p.subscriberAddressLine2,
    [p.subscriberCity, p.subscriberProvince, p.subscriberPostal].filter(Boolean).join(', '),
    p.subscriberCountry,
  ].filter(Boolean).join(', ');
  const regName = p.regName || p.subscriberName || '';
  const regAddr = p.regAddress || addr;
  const fmt = (n) => n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (iso) => {
    if (!iso) return new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    // YYYY-MM-DD inputs are parsed as UTC by default; force local-midnight so
    // an April 23 selection doesn't render as April 22 on EDT.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
  };

  const initials = initialsOf(p.typedSignature || p.subscriberName);
  const mark = (on) => on ? initials : '';
  const aiSet  = new Set(Array.isArray(p.aiCategories)   ? p.aiCategories   : []);
  const aionSet= new Set(Array.isArray(p.aionCategories) ? p.aionCategories : []);
  const usSet  = new Set(Array.isArray(p.usAiCategories) ? p.usAiCategories : []);
  // US AI spec asks for "SUB" when subscriber meets the criterion
  // (or "BEN" for beneficial purchaser).
  const usMark = (on) => on ? 'SUB' : '';
  // Form 45-106F9 is the "Risk Acknowledgement Form for Individual Accredited
  // Investors" — it only applies when the subscriber is an individual AND
  // has ticked the risk certification in step 5.
  const isIndividual = p.entityType === 'individual';
  const riskOn = isIndividual && Boolean(p.certifications && p.certifications.riskAcknowledged);

  const out = {
    // ---- face page ----
    SUBSCRIBER_NAME: p.subscriberName || '',
    OFFICIAL_CAPACITY: p.officialCapacity || (p.entityType === 'individual' ? 'Individual' : ''),
    SIGNATORY_NAME: p.signatoryName || p.subscriberName || '',
    SUBSCRIBER_ADDRESS: addr,
    SUBSCRIBER_PHONE: p.subscriberPhone || '',
    SUBSCRIBER_EMAIL: p.subscriberEmail || '',
    NUMBER_OF_SHARES: shares ? shares.toLocaleString('en-CA') : '',
    AGGREGATE_PRICE: shares ? fmt(price) : '',
    SUBSCRIPTION_NO: p.subscriptionNo || '',
    DISCLOSED_PRINCIPAL_NAME: p.disclosedPrincipalName || '',
    DISCLOSED_PRINCIPAL_ADDRESS: p.disclosedPrincipalAddress || '',
    REG_NAME: regName,
    REG_ADDRESS: regAddr,
    JURISDICTION_OF_RESIDENCE: p.jurisdictionOfResidence || '',
    AUTH_SIGNATORY_NAME_TITLE: p.entityType === 'individual' ? '' :
      `${p.signatoryName || ''}${p.officialCapacity ? ', ' + p.officialCapacity : ''}`,
    EXECUTION_DATE: fmtDate(p.executionDate),
    REGISTERED_CHECK: p.registrantStatus === 'registered' ? '[X]' : '[ ]',
    NOT_REGISTERED_CHECK: p.registrantStatus === 'not_registered' ? '[X]' : '[ ]',
    CURRENT_HOLDINGS: p.currentHoldings != null ? String(p.currentHoldings) : '0',

    // ---- F9 risk acknowledgement + income/asset criteria ----
    F9_RISK_LOSS:      mark(riskOn),
    F9_RISK_LIQUIDITY: mark(riskOn),
    F9_RISK_INFO:      mark(riskOn),
    F9_RISK_ADVICE:    mark(riskOn),
    F9_AI_INCOME_200K:  isIndividual ? mark(aiSet.has('k')) : '',
    F9_AI_INCOME_JOINT: isIndividual ? mark(aiSet.has('k')) : '',
    F9_AI_ASSETS_1M:    isIndividual ? mark(aiSet.has('j')) : '',
    F9_AI_NETWORTH_5M:  isIndividual ? mark(aiSet.has('l') || aiSet.has('j1')) : '',
    F9_NAME:      isIndividual ? (p.typedSignature || p.subscriberName || '') : '',
    F9_SIGNATURE: isIndividual ? (p.typedSignature || '') : '',
    F9_DATE:      isIndividual ? fmtDate(p.executionDate) : '',

    // ---- Schedule B FFBA relationship details ----
    FFBA_RELATIONSHIP_NAME:   p.ffbaRelationshipName   || '',
    FFBA_RELATIONSHIP_LENGTH: p.ffbaRelationshipLength || '',
    FFBA_RELATIONSHIP_NATURE: p.ffbaRelationshipNature || '',
    FFBA_PRIOR_DEALINGS:      p.ffbaPriorDealings      || '',
  };

  // ---- Schedule A Part 1 (Canadian AI) ----
  for (const c of AI_CODES)   out[`AI_${c}`]    = mark(aiSet.has(c));
  // ---- Schedule A Part 2 (Ontario AI) ----
  for (const c of AION_CODES) out[`AION_${c}`]  = mark(aionSet.has(c));
  // ---- Schedule B (FFBA) ----
  for (const c of FFBA_CODES) out[`FFBA_${c}`]  = p.ffbaCategory === c ? initials : '';
  // ---- Schedule C (US AI) ----
  for (let n = 1; n <= 8; n++) out[`USAI_${n}`] = usMark(usSet.has(String(n)));

  return out;
}

function generateDocxBlob(data) {
  if (!TEMPLATE_BYTES) throw new Error('Template not loaded for this deal.');
  if (typeof PizZip === 'undefined') throw new Error('PizZip library did not load.');
  const DocxTemplaterCtor = window.docxtemplater || window.Docxtemplater;
  if (!DocxTemplaterCtor) throw new Error('docxtemplater library did not load.');
  const zip = new PizZip(TEMPLATE_BYTES);
  const doc = new DocxTemplaterCtor(zip, {
    delimiters: { start: '{', end: '}' },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  });
  doc.render(buildPlaceholders(data));
  const out = doc.getZip().generate({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
  });
  const safe = (data.subscriberName || 'Subscriber').replace(/[^a-z0-9-]+/gi, '_').replace(/^_+|_+$/g, '');
  const slug = (DEAL && DEAL.slug) || 'deal';
  const filename = `${slug}_SubAgreement_${safe}_${new Date().toISOString().slice(0,10)}.docx`;
  return { blob: out, filename };
}

function validateAll() {
  for (let i = 1; i <= STEPS.length; i++) {
    if (!validateStep(i)) { showStep(i); return false; }
  }
  return true;
}

/* ---------- Submit handlers ---------- */
function downloadFilledDocx() {
  clearStatus();
  if (!validateAll()) return;
  try {
    const { blob, filename } = generateDocxBlob(collect());
    saveAs(blob, filename);
    showStatus(`Downloaded ${filename}. Review carefully before signing.`, 'ok');
  } catch (e) {
    console.error(e);
    showStatus('DOCX generation failed: ' + (e.message || e), 'err');
  }
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function submitSubscription() {
  clearStatus();
  if (!validateAll()) return;
  const data = collect();

  showStatus('Filing submission...', 'ok');

  try {
    // 1. Generate the DOCX blob locally
    const doc = generateDocxBlob(data);
    const b64 = await blobToBase64(doc.blob);
    
    // 2. Generate the Filing ID
    const now = new Date();
    const dateStr = now.getFullYear().toString() + (now.getMonth() + 1).toString().padStart(2, '0') + now.getDate().toString().padStart(2, '0');
    const timeStr = now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0') + now.getSeconds().toString().padStart(2, '0');
    const firstName = (data.subscriberName || 'USER').split(' ')[0].toUpperCase();
    const filingId = `${dateStr}-${timeStr}-${firstName}`;

    // 3. Attempt to save to the server (the "filing")
    let result = { ok: true, filingId: filingId, docxPath: doc.filename };
    try {
      const response = await fetch(`/api/deals/${encodeURIComponent(DEAL.slug)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          docxBase64: b64,
          docxFilename: doc.filename,
          filingId: filingId
        })
      });
      const serverResult = await response.json();
      if (serverResult.ok) result = serverResult;
    } catch (serverErr) {
      console.warn('Server filing failed, proceeding with local-only session:', serverErr);
    }

    console.log('Submission processed, redirecting to success UI...', result);
    await renderSuccessUI(data, doc, result, b64);
  } catch (e) {
    console.error(e);
    showStatus('Submission failed: ' + (e.message || e), 'err');
  }
}

/* ---------- Success View Handler ---------- */
/* ---------- Success View Handler ---------- */
async function renderSuccessUI(data, doc, result, docxBase64) {
  try {
    // Clear local storage since submission was successful
    localStorage.removeItem(LS_KEY);

    // Use passed base64 or encode if missing
    const b64 = docxBase64 || await blobToBase64(doc.blob);

    // Prepare data for the success page
    const successData = {
      filingId: result.filingId || `F-${Date.now()}`,
      docxPath: result.docxPath,
      docxFilename: doc.filename,
      docxBase64: b64,
      subscriberName: data.subscriberName,
      subscriberEmail: data.subscriberEmail,
      slug: DEAL.slug
    };

    // Store in session storage
    console.log('Saving result to sessionStorage:', successData.filingId);
    sessionStorage.setItem('last_filing_result', JSON.stringify(successData));

    // Redirect to the success page
    console.log('Redirecting to /success...');
    window.location.href = '/success';
  } catch (err) {
    console.error('renderSuccessUI failed:', err);
    showStatus('Submission saved but redirect failed: ' + err.message, 'err');
  }
}

/* ---------- Deal loader ---------- */
let portalConfig = { stripeConfigured: false };
async function loadPortalConfig() {
  try {
    const r = await fetch('/api/config');
    if (r.ok) portalConfig = Object.assign(portalConfig, await r.json());
  } catch {}
}

async function loadDealConfig() {
  try {
    const r = await fetch(`/api/deals/${encodeURIComponent(DEAL_SLUG)}/config`);
    if (!r.ok) throw new Error(`Deal "${DEAL_SLUG}" not found.`);
    DEAL = await r.json();
  } catch (err) {
    console.warn('Falling back to default deal config');
    DEAL = {
      slug: DEAL_SLUG || 'default-deal',
      displayName: 'Premium Growth Fund',
      issuer: 'Strategic Capital Corp',
      unitPrice: 10.00,
      currency: 'USD',
      unitName: 'share',
      unitNamePlural: 'shares',
      notifyEmail: 'investors@example.com'
    };
  }
  // Apply branding
  const initials = DEAL.displayName ? DEAL.displayName.split(/\s+/).filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase() : '··';
  const $$id = (id) => document.getElementById(id);
  if ($$id('brandMark'))  $$id('brandMark').textContent  = initials.slice(0,2) || '··';
  if ($$id('brandTitle')) $$id('brandTitle').textContent = DEAL.displayName || DEAL.slug;
  if ($$id('brandSub'))   $$id('brandSub').textContent   = DEAL.issuer ? `${DEAL.issuer} — ${DEAL.subTitle || 'Subscription Portal'}` : (DEAL.subTitle || 'Subscription Portal');
  if ($$id('offeringPill')) {
    const fmt = Number(DEAL.unitPrice||0).toLocaleString('en-CA', { style:'currency', currency:(DEAL.currency||'CAD') });
    $$id('offeringPill').textContent = `${fmt} / ${DEAL.unitName || 'unit'}`;
  }
  document.title = (DEAL.displayName || DEAL.slug) + ' · AutoSubDoc';

  // Re-label the per-deal form fields so a USD share offering doesn't say
  // "Number of common shares (CAD)".
  const sharesField = document.querySelector('input[name=numberOfShares]');
  if (sharesField) {
    const lbl = sharesField.closest('label')?.querySelector('span');
    if (lbl) lbl.textContent = `Number of ${DEAL.unitNamePlural || 'units'}`;
  }
  const aggField = document.querySelector('#aggregatePrice');
  if (aggField) {
    const lbl = aggField.closest('label')?.querySelector('span');
    if (lbl) lbl.textContent = `Aggregate subscription price (auto, ${DEAL.currency || 'CAD'})`;
  }
}

async function loadTemplate() {
  try {
    const r = await fetch(`/api/deals/${encodeURIComponent(DEAL_SLUG)}/template.docx`);
    if (!r.ok) throw new Error('Template fetch failed.');
    TEMPLATE_BYTES = new Uint8Array(await r.arrayBuffer());
  } catch (err) {
    console.warn('Falling back to embedded template data');
    if (window.TEMPLATE_DOCX_BASE64) {
      TEMPLATE_BYTES = base64ToUint8Array(window.TEMPLATE_DOCX_BASE64);
    } else {
      throw new Error('No template data available.');
    }
  }
}

const WIRE_INSTRUCTIONS_FALLBACK = 'Wire instructions for this deal have not been configured. Contact the issuer for routing details.';

async function startStripeCheckout(filing, data) {
  try {
    const res = await fetch(`/api/deals/${encodeURIComponent(DEAL.slug)}/stripe/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filingId: filing.filingId,
        subscriberName: data.subscriberName,
        subscriberEmail: data.subscriberEmail,
        numberOfShares: Number(data.numberOfShares),
        jurisdiction: data.jurisdictionOfResidence,
      }),
    });
    const out = await res.json();
    if (!res.ok || !out.ok) { alert('Stripe error: ' + (out.error || res.status)); return; }
    window.location.href = out.url;
  } catch (e) { alert('Could not start Stripe checkout: ' + e.message); }
}

function showWireModal() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.style.cssText = "position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,0.45); display: grid; place-items: center; animation: fade-in 0.3s ease; font-family: 'Sora', sans-serif;";
  
  const wire = (DEAL && DEAL.wireInstructions) ? DEAL.wireInstructions : WIRE_INSTRUCTIONS_FALLBACK;
  
  wrap.innerHTML = `
    <div style="background: #fff; border-radius: 20px; padding: 40px 36px; max-width: 500px; width: 90%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); text-align: center; position: relative;">
      <div style="width: 64px; height: 64px; background: #eff6ff; border-radius: 50%; display: grid; place-items: center; margin: 0 auto 20px; font-size: 28px; color: #2563eb;">
        <i class="ph-fill ph-bank"></i>
      </div>
      
      <h2 style="font-size: 20px; font-weight: 800; color: #0f172a; margin: 0 0 10px; letter-spacing: -0.5px; display: block;">Wire instructions</h2>
      <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
        Follow the instructions below to complete your wire transfer.
      </p>

      <div style="text-align: left; background: #fff; padding: 24px; border-radius: 12px; border: 1px solid #f1f5f9; margin-bottom: 24px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);">
        <div style="font-size: 14px; font-family: 'Sora', sans-serif; line-height: 1.8; color: #475569; margin: 0; white-space: pre-wrap; letter-spacing: -0.2px;">${escapeHtml(wire)}</div>
      </div>

      <button id="btn-wire-got-it" style="width: 100%; padding: 14px 32px; background: #2563eb; color: #fff; border: none; border-radius: 12px; font-weight: 700; font-size: 14px; cursor: pointer; font-family: 'Sora', sans-serif; transition: all 0.2s;">Got it</button>
      <button class="modal-close" style="position: absolute; top: 16px; right: 16px; background: none; border: none; font-size: 24px; color: #94a3b8; cursor: pointer;">&times;</button>
    </div>`;
    
  document.body.appendChild(wrap);
  
  const close = () => wrap.remove();
  wrap.querySelector('.modal-close').onclick = close;
  wrap.querySelector('#btn-wire-got-it').onclick = close;
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
}

/* ---------- Stripe return handling (?paid=1&filing=...&session_id=...) ---------- */
async function handleStripeReturn() {
  const q = new URLSearchParams(location.search);
  if (q.get('paid') !== '1') {
    if (q.get('cancelled') === '1') {
      showStatus(`Payment cancelled. Filing ${q.get('filing') || ''} is saved; you can pay later.`, 'err');
      history.replaceState({}, '', location.pathname);
    }
    return;
  }
  const sid = q.get('session_id'); const filing = q.get('filing');
  showStatus('Verifying payment with Stripe…', 'ok');
  try {
    const r = await fetch(`/api/deals/${encodeURIComponent(DEAL.slug)}/stripe/status?session_id=${encodeURIComponent(sid)}&filing=${encodeURIComponent(filing)}`);
    const j = await r.json();
    if (j.ok && j.paid) {
      const cad = (j.amountTotal / 100).toLocaleString('en-CA', { style: 'currency', currency: (j.currency||'cad').toUpperCase() });
      showStatus(`Payment received: ${cad}. Filing ${filing} marked paid in the Excel log.`, 'ok');
    } else {
      showStatus(`Payment not yet confirmed (status: ${j.paymentStatus || 'unknown'}).`, 'err');
    }
  } catch (e) {
    showStatus('Could not verify payment with Stripe: ' + e.message, 'err');
  }
  history.replaceState({}, '', location.pathname);
}

/* ---------- Filing confirmation modal ---------- */
function showFilingModal(data, doc, result) {
  const email = result.email || {};
  const emailOk = email.ok;
  const emailDetail = emailOk
    ? (email.state === 'opened'
        ? 'Email draft opened in Outlook with the DOCX and Excel attached — review and click Send.'
        : `Email draft saved: ${escapeHtml(email.emlPath || '')}. Double-click to open in your mail client.`)
    : `Email draft failed: ${escapeHtml(email.error || 'unknown error')}. The DOCX and Excel log are still saved; you can email manually.`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <header>
        <div class="filing-title">Subscription filed</div>
        <button class="modal-close" aria-label="Close">&times;</button>
      </header>
      <div class="modal-body">
        <div class="envelope-card">
          <div class="env-top">
            <div class="env-status">Filed</div>
            <div class="env-id">ID: ${escapeHtml(result.filingId)}</div>
          </div>
          <h3>${escapeHtml(data.subscriberName)} · ${Number(data.numberOfShares).toLocaleString()} ${escapeHtml((DEAL && DEAL.unitNamePlural) || 'units')} · ${(Number(data.numberOfShares)*((DEAL && Number(DEAL.unitPrice))||0.5)).toLocaleString('en-CA',{style:'currency',currency:((DEAL && DEAL.currency) || 'CAD')})}</h3>
          <p class="env-sub">Stored for legal filing and logged in the master spreadsheet.</p>

          <ol class="routing">
            <li class="done">
              <div class="dot"></div>
              <div>
                <div class="role">DOCX saved</div>
                <div class="who filepath">${escapeHtml(result.docxPath || '')}</div>
                <div class="state">Filed under <code>generated/filings/</code></div>
              </div>
            </li>
            <li class="done">
              <div class="dot"></div>
              <div>
                <div class="role">Excel log updated</div>
                <div class="who filepath">${escapeHtml(result.xlsxPath || '')}</div>
                <div class="state">One row appended to <code>subscriptions.xlsx</code></div>
              </div>
            </li>
            <li class="${emailOk ? 'done' : 'err'}">
              <div class="dot"></div>
              <div>
                <div class="role">Email draft</div>
                <div class="who">to: ${escapeHtml(DEAL && DEAL.notifyEmail || 'configured legal email')}</div>
                <div class="state">${emailDetail}</div>
              </div>
            </li>
          </ol>

          <div class="env-doc">
            <span class="doc-icon">📄</span>
            <div>
              <div>${escapeHtml(doc.filename)}</div>
              <div class="doc-meta">${(doc.blob.size/1024).toFixed(1)} KB · Subscription agreement + Schedule A/B/C</div>
            </div>
            <button class="btn secondary" data-download>Download copy</button>
          </div>
        </div>
      </div>
      <footer>
        <button class="btn ghost" data-close>Close</button>
        <button class="btn secondary" data-wire>Wire instructions</button>
        <button class="btn ghost" data-download>Download my copy</button>
        <button class="btn primary" data-stripe ${portalConfig.stripeConfigured ? '' : 'disabled title="Stripe not configured on the server"'}>Pay ${(Number(data.numberOfShares)*((DEAL && Number(DEAL.unitPrice))||0.5)).toLocaleString('en-CA',{style:'currency',currency:((DEAL && DEAL.currency) || 'CAD')})} with card</button>
      </footer>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').onclick = close;
  overlay.querySelector('[data-close]').onclick = close;
  overlay.querySelectorAll('[data-download]').forEach((b) => { b.onclick = () => saveAs(doc.blob, doc.filename); });
  overlay.querySelector('[data-wire]').onclick = showWireModal;
  const stripeBtn = overlay.querySelector('[data-stripe]');
  if (stripeBtn && !stripeBtn.disabled) {
    stripeBtn.onclick = () => startStripeCheckout(result, data);
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const notify = (DEAL && DEAL.notifyEmail) || 'the configured legal email';
  showStatus(emailOk
    ? `Filed ${result.filingId}. Emailed to ${notify}.`
    : `Filed ${result.filingId}. Email failed — saved locally.`,
    emailOk ? 'ok' : 'err');
}

/* ---------- Init ---------- */
async function init() {
  await populateCountries();
  applyCustomSelects();
  populateAI();
  wireConditionals();
  await restoreFromLocalStorage();
  renderStepper();
  renderSummary();

  try {
    await Promise.all([loadPortalConfig(), loadDealConfig()]);
    await loadTemplate();
  } catch (e) {
    showStatus('Could not load deal: ' + e.message, 'err');
    document.querySelectorAll('button[data-action], button[type=submit]').forEach(b => b.disabled = true);
  }
  handleStripeReturn();

  $('#docusignNote').textContent =
    `Submitting saves the filled DOCX under deals/${DEAL && DEAL.slug || '<slug>'}/filings/, appends a row ` +
    `to that deal's Excel log, and opens a pre-populated email draft to ${(DEAL && DEAL.notifyEmail) || 'the configured legal email'} ` +
    `with the DOCX and Excel attached.`;

  $('[data-nav=next]').addEventListener('click', () => {
    if (validateStep(currentStep)) showStep(currentStep + 1);
  });
  $('[data-nav=back]').addEventListener('click', () => showStep(currentStep - 1));

  $('[data-action=download]').addEventListener('click', downloadFilledDocx);
  
  const sendBtn = document.getElementById('sendButton');
  if (sendBtn) {
    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      submitSubscription();
    });
  }
}

init();
