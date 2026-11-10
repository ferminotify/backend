// Gestionale: filters, pages, sorting and tabs without reloading the page.
// The server renders the same HTML in pieces: ?part=list = one list (only its queries), ?part=main = the page
// content. This script fetches the piece of the region the control sits in ([data-region]) and swaps it in,
// keeping the URL in sync. Without it every control still works as a normal link or form.
(() => {
  const busy = new WeakMap(); // region -> AbortController of its request in flight

  async function load(url, region, push) {
    const target = new URL(url, location.href);
    target.searchParams.delete('part');
    const request = new URL(target);
    request.searchParams.set('part', region.dataset.region);

    busy.get(region)?.abort();
    const ctrl = new AbortController();
    busy.set(region, ctrl);
    region.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(request, { signal: ctrl.signal, headers: { Accept: 'text/html' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();

      // The search box being typed in: same box, same text and caret after the swap.
      const active = document.activeElement;
      const typing = active && region.contains(active) && active.name ? active : null;
      const caret = typing && typeof typing.selectionStart === 'number' ? [typing.selectionStart, typing.selectionEnd] : null;
      region.innerHTML = body;
      if (typing) {
        const again = region.querySelector(`[name="${CSS.escape(typing.name)}"]`);
        if (again) {
          if ('value' in again && again.type === 'search') again.value = typing.value;
          again.focus();
          if (caret && again.setSelectionRange) try { again.setSelectionRange(...caret); } catch { /* not a text box */ }
        }
      }
      const title = res.headers.get('X-Page-Title');
      if (title) document.title = decodeURIComponent(title);
      history[push ? 'pushState' : 'replaceState']({ region: true }, '', target);
    } catch (err) {
      if (err.name === 'AbortError') return;
      location.href = target; // something went wrong: plain page load
    } finally {
      if (busy.get(region) === ctrl) {
        busy.delete(region);
        region.removeAttribute('aria-busy');
      }
    }
  }

  const regionOf = (el) => el.closest('[data-region]');

  // Filters: the form's own fields make the new query string, as a GET form would.
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const region = form.matches('form.filters') && regionOf(form);
    if (!region) return;
    e.preventDefault();
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v !== '') params.set(k, v);
    const url = new URL(location.href);
    url.search = params.toString();
    const live = form.dataset.live === '1';
    delete form.dataset.live;
    load(url, region, !live);
  });

  // Pages, sorting, tabs: links to "?…" inside a region (CSV downloads and other pages load normally).
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="?"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (/(?:^|[?&])format=/.test(a.getAttribute('href'))) return;
    const region = regionOf(a);
    if (!region) return;
    e.preventDefault();
    load(a.href, region, true);
  });

  // Apply as you choose or type: selects at once, the search box after a pause (one history entry).
  let timer = 0;
  document.addEventListener('change', (e) => {
    const form = e.target.closest('form.filters');
    if (form && e.target.tagName === 'SELECT') form.requestSubmit();
  });
  document.addEventListener('input', (e) => {
    const form = e.target.closest('form.filters');
    if (!form || e.target.type !== 'search') return;
    clearTimeout(timer);
    timer = setTimeout(() => { form.dataset.live = '1'; form.requestSubmit(); }, 300);
  });

  // Back and forward: the whole page content for that URL.
  window.addEventListener('popstate', () => {
    const main = document.querySelector('[data-region="main"]');
    if (main) load(location.href, main, false);
  });
})();
