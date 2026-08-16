(function(){const r=document.createElement("link").relList;if(r&&r.supports&&r.supports("modulepreload"))return;for(const t of document.querySelectorAll('link[rel="modulepreload"]'))o(t);new MutationObserver(t=>{for(const c of t)if(c.type==="childList")for(const l of c.addedNodes)l.tagName==="LINK"&&l.rel==="modulepreload"&&o(l)}).observe(document,{childList:!0,subtree:!0});function s(t){const c={};return t.integrity&&(c.integrity=t.integrity),t.referrerPolicy&&(c.referrerPolicy=t.referrerPolicy),t.crossOrigin==="use-credentials"?c.credentials="include":t.crossOrigin==="anonymous"?c.credentials="omit":c.credentials="same-origin",c}function o(t){if(t.ep)return;t.ep=!0;const c=s(t);fetch(t.href,c)}})();const E="http://localhost:3001",$=document.querySelector("#app"),u=new Intl.NumberFormat("en-US"),P=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0});let a={summary:null,timeseries:[],categories:[],recent:[],theme:document.documentElement.dataset.theme||"light",error:null},y;function w(e){a.theme=e==="dark"?"dark":"light",document.documentElement.dataset.theme=a.theme;try{sessionStorage.setItem("dashboard-theme",a.theme)}catch{}const r=document.querySelector('meta[name="color-scheme"]');r&&(r.content=a.theme),k()}async function m(e,r){const s=await fetch(`${E}${e}`,{headers:{"Content-Type":"application/json"},...r});if(!s.ok)throw new Error(`${e} returned ${s.status}`);return s.json()}async function A(){f(!0);try{const e=await m("/api/settings");w(e.theme);const[r,s,o,t]=await Promise.all([m("/api/summary"),m("/api/timeseries"),m("/api/categories"),m("/api/recent")]);a={...a,summary:r,timeseries:s,categories:o,recent:t,error:null},f(!1)}catch(e){console.error(e),a.error="Unable to load dashboard data. Start the backend API and refresh the page.",a.summary=null,a.timeseries=[],a.categories=[],a.recent=[],f(!1)}}function f(e=!1){var r;$.innerHTML=`
    <div class="dashboard">
      <header class="site-header">
        <div class="title-block">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
        </div>
        <button class="theme-toggle" type="button" aria-label="Toggle dark theme" aria-pressed="${a.theme==="dark"}">
          <span class="toggle-icon">${a.theme==="dark"?"☾":"☀"}</span>
          <span>${a.theme==="dark"?"Dark":"Light"}</span>
        </button>
      </header>
      ${e?U():a.error?z(a.error):H()}
    </div>
  `,(r=$.querySelector(".theme-toggle"))==null||r.addEventListener("click",G),!e&&!a.error&&(k(),J())}function U(){return'<main class="empty-card"><h2>Loading dashboard…</h2><p>Fetching metrics from the PGLite-backed API.</p></main>'}function z(e){return`<main class="empty-card error-state"><h2>Dashboard unavailable</h2><p>${d(e)}</p><button class="retry" type="button">Retry</button></main>`}function H(){return`
    <main>
      <section class="stats-grid" aria-label="Summary metrics">
        ${g("Total Visitors",u.format(a.summary.totalVisitors),`${W(a.summary.sevenDayTrend)} vs prior 7 days`,a.summary.sevenDayTrend>=0)}
        ${g("Total Revenue",P.format(a.summary.totalRevenue),"30-day generated revenue",!0)}
        ${g("Best Day",V(a.summary.bestDay.date),`${u.format(a.summary.bestDay.visitors)} visitors`,!0)}
        ${g("Largest Category",u.format(a.summary.largestCategoryValue),"Seeded 7-digit value check",!0,"wide-number")}
      </section>

      <section class="body-grid">
        <article class="panel chart-panel">
          <div class="panel-heading">
            <div><p class="eyebrow">30 days</p><h2>Visitor trend</h2></div>
            <span class="panel-note">SVG redraws on resize</span>
          </div>
          <div class="chart-wrap" id="timeseries-chart" role="img" aria-label="Line chart of visitors over the last 30 days"></div>
        </article>

        <article class="panel categories-panel">
          <div class="panel-heading">
            <div><p class="eyebrow">Breakdown</p><h2>Categories</h2></div>
          </div>
          <div class="bars" aria-label="Category values">
            ${a.categories.map(B).join("")}
          </div>
        </article>
      </section>

      <section class="panel table-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Latest 20</p><h2>Recent items</h2></div>
        </div>
        ${_()}
      </section>
    </main>
  `}function g(e,r,s,o,t=""){return`
    <article class="stat-card ${t}">
      <p>${e}</p>
      <strong title="${d(String(r))}">${r}</strong>
      <span class="trend ${o?"positive":"negative"}">${o?"▲":"▼"} ${s}</span>
    </article>
  `}function B(e){const r=Math.max(...a.categories.map(o=>o.value)),s=Math.max(4,e.value/r*100);return`
    <div class="bar-row">
      <div class="bar-meta">
        <span class="bar-label" title="${d(e.label)}">${d(e.label)}</span>
        <strong>${u.format(e.value)}</strong>
      </div>
      <div class="bar-track"><span class="bar-fill" style="width:${s}%"></span></div>
    </div>
  `}function _(){return`
    <div class="table-scroller">
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>Value</th><th>Created</th></tr></thead>
        <tbody>
          ${a.recent.map(e=>`
            <tr>
              <td data-label="Name"><span class="cell-strong">${d(e.name)}</span></td>
              <td data-label="Category"><span class="truncate" title="${d(e.category)}">${d(e.category)}</span></td>
              <td data-label="Value">${P.format(e.value)}</td>
              <td data-label="Created">${V(e.created_at)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `}async function G(){const e=a.theme==="dark"?"light":"dark";w(e),f(!1);try{const r=await m("/api/settings",{method:"PUT",body:JSON.stringify({theme:e})});w(r.theme);const s=$.querySelector(".theme-toggle");s&&(s.setAttribute("aria-pressed",String(r.theme==="dark")),s.innerHTML=`<span class="toggle-icon">${r.theme==="dark"?"☾":"☀"}</span><span>${r.theme==="dark"?"Dark":"Light"}</span>`)}catch(r){console.error(r)}}function J(){y&&y.disconnect();const e=document.querySelector("#timeseries-chart");e&&(y=new ResizeObserver(()=>k()),y.observe(e))}function k(){const e=document.querySelector("#timeseries-chart");if(!e||!a.timeseries.length)return;const r=Math.max(280,Math.floor(e.clientWidth)),s=Math.max(250,Math.floor(e.clientHeight||300)),o=r<420,t={top:18,right:o?24:18,bottom:o?48:42,left:o?46:60},c=Math.max(1,r-t.left-t.right),l=Math.max(1,s-t.top-t.bottom),S=a.timeseries.map(n=>n.visitors),b=Math.floor(Math.min(...S)/250)*250,M=Math.ceil(Math.max(...S)/250)*250-b||1,p=n=>t.left+n/(a.timeseries.length-1)*c,v=n=>t.top+l-(n-b)/M*l,D=a.timeseries.map((n,i)=>`${i===0?"M":"L"} ${p(i).toFixed(2)} ${v(n.visitors).toFixed(2)}`).join(" "),F=Array.from({length:5},(n,i)=>b+M/4*i),I=o?[0,14,29]:[0,7,14,21,29],h=getComputedStyle(document.documentElement),N=h.getPropertyValue("--chart-grid").trim(),x=h.getPropertyValue("--chart-axis").trim(),L=h.getPropertyValue("--muted").trim(),T=h.getPropertyValue("--accent").trim(),O=h.getPropertyValue("--accent-soft").trim(),R=`${D} L ${p(a.timeseries.length-1).toFixed(2)} ${t.top+l} L ${t.left} ${t.top+l} Z`;e.innerHTML=`
    <svg viewBox="0 0 ${r} ${s}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="0" width="${r}" height="${s}" fill="transparent"></rect>
      ${F.map(n=>{const i=v(n);return`<line x1="${t.left}" y1="${i}" x2="${r-t.right}" y2="${i}" stroke="${N}" stroke-width="1" />
          <text x="${t.left-8}" y="${i+4}" text-anchor="end" fill="${L}" font-size="11">${u.format(Math.round(n))}</text>`}).join("")}
      <line x1="${t.left}" y1="${t.top}" x2="${t.left}" y2="${s-t.bottom}" stroke="${x}" stroke-width="1" />
      <line x1="${t.left}" y1="${s-t.bottom}" x2="${r-t.right}" y2="${s-t.bottom}" stroke="${x}" stroke-width="1" />
      <path d="${R}" fill="${O}" opacity="0.45"></path>
      <path d="${D}" fill="none" stroke="${T}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
      ${a.timeseries.map((n,i)=>i%(o?7:5)===0||i===a.timeseries.length-1?`<circle cx="${p(i)}" cy="${v(n.visitors)}" r="3" fill="${T}" />`:"").join("")}
      ${I.map(n=>{const i=p(n),j=K(a.timeseries[n].date),q=n===0?"start":n===a.timeseries.length-1?"end":"middle";return`<line x1="${i}" y1="${s-t.bottom}" x2="${i}" y2="${s-t.bottom+5}" stroke="${x}" />
          <text x="${i}" y="${s-t.bottom+20}" text-anchor="${q}" fill="${L}" font-size="11">${j}</text>`}).join("")}
    </svg>
  `}function W(e){return`${Math.abs(e).toFixed(1)}%`}function C(e){const r=String(e);if(/^\d{4}-\d{2}-\d{2}$/.test(r)){const[s,o,t]=r.split("-").map(Number);return new Date(s,o-1,t,12,0,0)}return new Date(e)}function V(e){const r=C(e);return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric"}).format(r)}function K(e){const r=C(e);return new Intl.DateTimeFormat("en-US",{month:"numeric",day:"numeric"}).format(r)}function d(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}$.addEventListener("click",e=>{e.target.closest(".retry")&&A()});A();
