// Small date picker used instead of the browser's native one, so the year list behaves predictably:
//   * the list only contains years the instrument/range allows (no greyed-out padding years),
//   * clicking a year opens that year's months; clicking the SAME year again closes them,
//   * days outside the allowed range (first year .. yesterday, and the 2-year window) are disabled.
// The input keeps its value as an ISO date (YYYY-MM-DD) and fires a normal `change` event when a day is picked.
// Allowed range is read from `input.min` / `input.max` (plain properties set by app.js) every time it opens.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEK = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${pad(m + 1)}-${pad(d)}`; // m: 0-11
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const firstWeekday = (y, m) => new Date(Date.UTC(y, m, 1)).getUTCDay();

export function attachDatePicker(input) {
  input.readOnly = true;
  input.placeholder = 'yyyy-mm-dd';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-haspopup', 'dialog');

  let pop = null;
  let view = 'days'; // 'days' | 'years'
  let cur = { y: 2026, m: 0 };
  let openYear = null; // the year whose months are shown in the year list

  const range = () => {
    const min = input.min || '0001-01-01';
    const max = input.max || '9999-12-31';
    return { min, max, minY: Number(min.slice(0, 4)), maxY: Number(max.slice(0, 4)) };
  };
  const monthAllowed = (y, m, r) => iso(y, m, daysIn(y, m)) >= r.min && iso(y, m, 1) <= r.max;

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    input.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
  }
  const onOutside = (e) => {
    if (pop && !pop.contains(e.target) && e.target !== input) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      input.focus();
    }
  };

  function place() {
    const r = input.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${r.bottom + window.scrollY + 4}px`;
  }

  const button = (text, cls, onClick, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.disabled = disabled;
    if (!disabled) b.addEventListener('click', onClick);
    return b;
  };

  function render() {
    const r = range();
    pop.textContent = '';

    if (view === 'days') {
      const head = document.createElement('div');
      head.className = 'dp-head';
      const prevOk = monthAllowed(cur.m === 0 ? cur.y - 1 : cur.y, (cur.m + 11) % 12, r);
      const nextOk = monthAllowed(cur.m === 11 ? cur.y + 1 : cur.y, (cur.m + 1) % 12, r);
      head.append(
        button('‹', 'dp-nav', () => { cur = cur.m === 0 ? { y: cur.y - 1, m: 11 } : { y: cur.y, m: cur.m - 1 }; render(); }, !prevOk),
        button(`${MONTHS[cur.m]} ${cur.y} ▾`, 'dp-title', () => { view = 'years'; openYear = cur.y; render(); }),
        button('›', 'dp-nav', () => { cur = cur.m === 11 ? { y: cur.y + 1, m: 0 } : { y: cur.y, m: cur.m + 1 }; render(); }, !nextOk),
      );
      pop.append(head);

      const grid = document.createElement('div');
      grid.className = 'dp-grid';
      for (const w of WEEK) {
        const c = document.createElement('span');
        c.className = 'dp-dow';
        c.textContent = w;
        grid.append(c);
      }
      for (let i = 0; i < firstWeekday(cur.y, cur.m); i++) grid.append(document.createElement('span'));
      for (let d = 1; d <= daysIn(cur.y, cur.m); d++) {
        const date = iso(cur.y, cur.m, d);
        const b = button(String(d), `dp-day${date === input.value ? ' selected' : ''}`, () => {
          input.value = date;
          close();
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, date < r.min || date > r.max);
        if (date === input.value) b.setAttribute('aria-pressed', 'true');
        grid.append(b);
      }
      pop.append(grid);
    } else {
      const list = document.createElement('div');
      list.className = 'dp-years';
      for (let y = r.minY; y <= r.maxY; y++) {
        const open = openYear === y;
        const row = button(String(y), `dp-year${open ? ' open' : ''}`, () => {
          openYear = openYear === y ? null : y; // second click on the same year hides its months again
          render();
        });
        row.setAttribute('aria-expanded', String(open));
        list.append(row);
        if (open) {
          const months = document.createElement('div');
          months.className = 'dp-months';
          for (let m = 0; m < 12; m++) {
            months.append(button(SHORT[m], `dp-month${y === cur.y && m === cur.m ? ' selected' : ''}`, () => {
              cur = { y, m };
              view = 'days';
              render();
            }, !monthAllowed(y, m, r)));
          }
          list.append(months);
        }
      }
      pop.append(list);
      list.querySelector('.dp-year.open')?.scrollIntoView({ block: 'nearest' });
    }
    place();
  }

  function open() {
    if (pop) return;
    const r = range();
    const base = input.value || r.max;
    cur = { y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) - 1 };
    if (iso(cur.y, cur.m, 1) > r.max) cur = { y: Number(r.max.slice(0, 4)), m: Number(r.max.slice(5, 7)) - 1 };
    view = 'days';
    openYear = cur.y;
    pop = document.createElement('div');
    pop.className = 'dp-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a date');
    document.body.append(pop);
    input.setAttribute('aria-expanded', 'true');
    render();
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
  }

  input.addEventListener('click', () => (pop ? close() : open()));
  input.addEventListener('keydown', (e) => {
    if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });
  return { open, close };
}
