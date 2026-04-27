const { JSDOM } = require('jsdom');
const dom = new JSDOM(`
  <label id="lbl">
    <span id="text">Label</span>
    <select id="sel" hidden></select>
    <div id="trigger">trigger</div>
  </label>
`);
const { document } = dom.window;

let events = [];
let isOpen = false;

function openDropdown() {
  isOpen = true;
  events.push('opened');
}
function closeDropdown() {
  isOpen = false;
  events.push('closed');
}
function toggleDropdown() {
  if (isOpen) closeDropdown();
  else openDropdown();
}

const trigger = document.getElementById('trigger');
const select = document.getElementById('sel');

trigger.addEventListener('click', (e) => {
  e.preventDefault();
  toggleDropdown();
});

select.addEventListener('click', (e) => {
  e.preventDefault();
  if (!isOpen) openDropdown();
});

document.addEventListener('click', (e) => {
  if (e.target === select) return;
  const wrapperContains = e.target === trigger;
  if (!wrapperContains) closeDropdown();
});

document.getElementById('text').click();
console.log('After text click:', events);

events = [];
trigger.click();
console.log('After trigger click:', events);

