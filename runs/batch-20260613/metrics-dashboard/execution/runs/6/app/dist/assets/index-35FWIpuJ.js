(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const e of document.querySelectorAll('link[rel="modulepreload"]'))o(e);new MutationObserver(e=>{for(const i of e)if(i.type==="childList")for(const u of i.addedNodes)u.tagName==="LINK"&&u.rel==="modulepreload"&&o(u)}).observe(document,{childList:!0,subtree:!0});function r(e){const i={};return e.integrity&&(i.integrity=e.integrity),e.referrerPolicy&&(i.referrerPolicy=e.referrerPolicy),e.crossOrigin==="use-credentials"?i.credentials="include":e.crossOrigin==="anonymous"?i.credentials="omit":i.credentials="same-origin",i}function o(e){if(e.ep)return;e.ep=!0;const i=r(e);fetch(e.href,i)}})();const k=document.querySelector("#app"),s={summary:null,timeseries:[],categories:[],recent:[],theme:"light",resizeObserver:null},v=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}),w=new Intl.NumberFormat("en-US"),F=new Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1});function h(t){return String(t).replace(/[&<>'"]/g,a=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[a])}async function m(t,a){const r=await fetch(t,{headers:{"Content-Type":"application/json",...(a==null?void 0:a.headers)||{}},...a});if(!r.ok)throw new Error(`${t} returned ${r.status}`);return r.json()}async function I(){try{const t=await m("/api/settings");s.theme=t.theme==="dark"?"dark":"light"}catch{s.theme="light"}document.documentElement.dataset.theme=s.theme,document.documentElement.style.visibility="visible"}function S(t){var a;k.innerHTML=`
    <div class="page-shell">
      <header class="topbar">
        <div class="brand-block">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
        </div>
        <button class="theme-toggle" type="button" aria-pressed="${s.theme==="dark"}" aria-label="Toggle dark theme">
          <span class="toggle-track"><span class="toggle-dot"></span></span>
          <span class="toggle-text">${s.theme==="dark"?"Dark":"Light"}</span>
        </button>
      </header>
      ${t}
    </div>`,(a=k.querySelector(".theme-toggle"))==null||a.addEventListener("click",A)}function V(){S('<main class="status-card" role="status"><div class="spinner"></div><p>Loading metrics from the API…</p></main>')}function z(t){var a;S(`
    <main class="status-card error-state" role="alert">
      <h2>Dashboard data is unavailable</h2>
      <p>${h(t)}</p>
      <p class="muted">Start the backend server and reload. No hardcoded dashboard data is shown when the API cannot be reached.</p>
      <button class="retry" type="button">Retry</button>
    </main>`),(a=k.querySelector(".retry"))==null||a.addEventListener("click",M)}function E(){var o;const t=new Date(`${s.summary.bestDay.day}T00:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric"}),a=s.summary.sevenDayTrendPercent,r=a>=0;S(`
    <main class="dashboard-grid">
      <section class="stat-card" aria-label="Total visitors">
        <span class="card-label">Total visitors</span>
        <strong class="stat-value fit-number">${w.format(s.summary.totalVisitors)}</strong>
        <span class="stat-note ${r?"up":"down"}">${r?"▲":"▼"} ${Math.abs(a).toFixed(1)}% 7-day trend</span>
      </section>
      <section class="stat-card" aria-label="Total revenue">
        <span class="card-label">Total revenue</span>
        <strong class="stat-value fit-number">${v.format(s.summary.totalRevenue)}</strong>
        <span class="stat-note">Seeded 30-day total</span>
      </section>
      <section class="stat-card" aria-label="Best revenue day">
        <span class="card-label">Best day</span>
        <strong class="stat-value">${t}</strong>
        <span class="stat-note">${v.format(s.summary.bestDay.revenue)} revenue</span>
      </section>
      <section class="stat-card" aria-label="Largest category value">
        <span class="card-label">Largest category</span>
        <strong class="stat-value fit-number">${w.format(Math.max(...s.categories.map(e=>e.value)))}</strong>
        <span class="stat-note truncate">${h(((o=s.categories[0])==null?void 0:o.label)||"")}</span>
      </section>

      <section class="panel chart-panel">
        <div class="panel-head">
          <div>
            <h2>30-day visitor trend</h2>
            <p class="muted">Hand-drawn SVG, resized to its card.</p>
          </div>
        </div>
        <div id="lineChart" class="chart-box" aria-label="30 day line chart"></div>
      </section>

      <section class="panel category-panel">
        <div class="panel-head"><h2>Category breakdown</h2></div>
        <div class="bars">
          ${s.categories.map(U).join("")}
        </div>
      </section>

      <section class="panel table-panel">
        <div class="panel-head"><h2>Recent items</h2></div>
        <div class="responsive-table" role="region" aria-label="Recent items table">
          <table>
            <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Created</th></tr></thead>
            <tbody>
              ${s.recent.map(e=>`
                <tr>
                  <td data-label="Name"><span class="cell-main">${h(e.name)}</span></td>
                  <td data-label="Category"><span class="pill truncate">${h(e.category)}</span></td>
                  <td data-label="Value">${v.format(e.value)}</td>
                  <td data-label="Created">${new Date(e.createdAt).toLocaleDateString("en-US",{month:"short",day:"numeric"})}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </section>
    </main>`),R(),T()}function U(t){const a=Math.max(...s.categories.map(o=>o.value)),r=Math.max(7,t.value/a*100);return`
    <div class="bar-row">
      <div class="bar-meta">
        <span class="bar-label truncate" title="${h(t.label)}">${h(t.label)}</span>
        <span class="bar-value">${w.format(t.value)}</span>
      </div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${r}%"></div></div>
    </div>`}function R(){s.resizeObserver&&s.resizeObserver.disconnect();const t=document.querySelector("#lineChart");t&&(s.resizeObserver=new ResizeObserver(()=>T()),s.resizeObserver.observe(t))}function y(t){return getComputedStyle(document.documentElement).getPropertyValue(t).trim()}function T(){const t=document.querySelector("#lineChart");if(!t||!s.timeseries.length)return;const a=Math.max(280,Math.floor(t.clientWidth)),r=Math.max(260,Math.floor(t.clientHeight||300)),o=a<430,e={top:18,right:o?12:24,bottom:o?58:46,left:o?48:62},i=Math.max(10,a-e.left-e.right),u=Math.max(10,r-e.top-e.bottom),l=s.timeseries.map(n=>n.visitors),p=Math.floor(Math.min(...l)/500)*500,b=Math.ceil(Math.max(...l)/500)*500,c=n=>e.left+n/(l.length-1)*i,g=n=>e.top+(1-(n-p)/(b-p||1))*u,D=l.map((n,d)=>`${c(d).toFixed(1)},${g(n).toFixed(1)}`).join(" "),C=[p,p+(b-p)/2,b],O=o?[0,14,29]:[0,7,14,21,29],f=y("--axis"),P=y("--grid"),$=y("--muted"),L=y("--series"),N=y("--series-fill");t.innerHTML=`
    <svg class="line-svg" width="${a}" height="${r}" viewBox="0 0 ${a} ${r}" role="img" aria-labelledby="chartTitle chartDesc">
      <title id="chartTitle">30-day visitors line chart</title>
      <desc id="chartDesc">Visitor counts from ${s.timeseries[0].date} through ${s.timeseries.at(-1).date}</desc>
      <rect x="0" y="0" width="${a}" height="${r}" fill="transparent" />
      ${C.map(n=>`
        <line x1="${e.left}" x2="${a-e.right}" y1="${g(n)}" y2="${g(n)}" stroke="${P}" stroke-width="1" />
        <text x="${e.left-8}" y="${g(n)+4}" text-anchor="end" class="chart-label" fill="${$}">${F.format(n)}</text>`).join("")}
      <line x1="${e.left}" x2="${e.left}" y1="${e.top}" y2="${r-e.bottom}" stroke="${f}" />
      <line x1="${e.left}" x2="${a-e.right}" y1="${r-e.bottom}" y2="${r-e.bottom}" stroke="${f}" />
      <polygon points="${e.left},${r-e.bottom} ${D} ${a-e.right},${r-e.bottom}" fill="${N}" opacity="0.7" />
      <polyline points="${D}" fill="none" stroke="${L}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      ${l.map((n,d)=>d%3===0||d===l.length-1?`<circle cx="${c(d)}" cy="${g(n)}" r="2.5" fill="${L}" />`:"").join("")}
      ${O.map(n=>{const j=new Date(`${s.timeseries[n].date}T00:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric"}),q=o?` transform="rotate(-35 ${c(n)} ${r-e.bottom+24})"`:"";return`<line x1="${c(n)}" x2="${c(n)}" y1="${r-e.bottom}" y2="${r-e.bottom+5}" stroke="${f}" />
          <text x="${c(n)}" y="${r-e.bottom+24}" text-anchor="${o?"end":"middle"}" class="chart-label" fill="${$}"${q}>${j}</text>`}).join("")}
      <text x="${e.left}" y="${r-12}" class="chart-caption" fill="${$}">Visitors</text>
    </svg>`}async function A(){const t=s.theme==="dark"?"light":"dark",a=s.theme;x(t);try{const r=await m("/api/settings",{method:"PUT",body:JSON.stringify({theme:t})});x(r.theme)}catch{x(a),alert("Could not save theme preference. Please try again.")}}function x(t){s.theme=t==="dark"?"dark":"light",document.documentElement.dataset.theme=s.theme;const a=document.querySelector(".theme-toggle");a&&(a.setAttribute("aria-pressed",String(s.theme==="dark")),a.querySelector(".toggle-text").textContent=s.theme==="dark"?"Dark":"Light"),T()}async function M(){V();try{const[t,a,r,o]=await Promise.all([m("/api/summary"),m("/api/timeseries"),m("/api/categories"),m("/api/recent")]);s.summary=t,s.timeseries=a,s.categories=r,s.recent=o,E()}catch(t){console.error(t),z("The dashboard could not fetch JSON from the metrics API.")}}I().then(M);
