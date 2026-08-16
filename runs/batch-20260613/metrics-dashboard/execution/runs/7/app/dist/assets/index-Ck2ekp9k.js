(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))a(n);new MutationObserver(n=>{for(const o of n)if(o.type==="childList")for(const d of o.addedNodes)d.tagName==="LINK"&&d.rel==="modulepreload"&&a(d)}).observe(document,{childList:!0,subtree:!0});function r(n){const o={};return n.integrity&&(o.integrity=n.integrity),n.referrerPolicy&&(o.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?o.credentials="include":n.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function a(n){if(n.ep)return;n.ep=!0;const o=r(n);fetch(n.href,o)}})();const P=document.querySelector("#app"),g=new Intl.NumberFormat("en-US"),N=new Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1}),x=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}),F=new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric"});let s={summary:null,timeseries:[],categories:[],recent:[],theme:document.documentElement.dataset.theme||"light"},p=null;function c(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function h(e,t){return fetch(e,{headers:{"Content-Type":"application/json",...(t==null?void 0:t.headers)||{}},cache:"no-store",...t}).then(async r=>{if(!r.ok){const a=await r.text().catch(()=>"");throw new Error(a||`Request failed: ${r.status}`)}return r.json()})}function q(e){return F.format(new Date(`${e}T00:00:00Z`))}function O(){P.innerHTML=`
    <header class="site-header">
      <div class="title-block">
        <p class="eyebrow">Read-mostly analytics</p>
        <h1>Metrics Dashboard</h1>
      </div>
      <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle dark theme">
        <span class="toggle-track" aria-hidden="true"><span class="toggle-dot"></span></span>
        <span id="themeLabel">${s.theme==="dark"?"Dark":"Light"}</span>
      </button>
    </header>
    <main id="dashboard" class="dashboard" aria-live="polite">
      <section class="loading-card">Loading dashboard data…</section>
    </main>
  `,document.querySelector("#themeToggle").addEventListener("click",J)}function V(e){const t=document.querySelector("#dashboard");t.innerHTML=`
    <section class="error-state">
      <h2>Dashboard data is unavailable</h2>
      <p>The page renders from the API only. Start the backend server and retry to load metrics.</p>
      <pre>${c(e.message||e)}</pre>
      <button id="retryButton" type="button">Retry</button>
    </section>
  `,document.querySelector("#retryButton").addEventListener("click",R)}function B(e){return[{label:"Total Visitors",value:g.format(e.totalVisitors),note:"30-day total",trend:`${e.sevenDayTrend>=0?"+":""}${e.sevenDayTrend}% last 7 days`},{label:"Total Revenue",value:x.format(e.totalRevenue),note:"30-day total",trend:"Seeded from PGLite"},{label:"Best Day",value:q(e.bestDay.date),note:`${g.format(e.bestDay.visitors)} visitors`,trend:x.format(e.bestDay.revenue)},{label:"7-Day Trend",value:`${e.sevenDayTrend>=0?"+":""}${e.sevenDayTrend}%`,note:"Visitors vs previous week",trend:e.sevenDayTrend>=0?"Improving":"Cooling"}].map(r=>`
    <article class="card stat-card">
      <div class="stat-label">${c(r.label)}</div>
      <div class="stat-value" title="${c(r.value)}">${c(r.value)}</div>
      <div class="stat-note">${c(r.note)}</div>
      <div class="stat-trend ${e.sevenDayTrend>=0?"positive":"negative"}">${c(r.trend)}</div>
    </article>
  `).join("")}function E(){const e=document.querySelector("#dashboard");e.innerHTML=`
    <section class="stats-grid" aria-label="Summary statistics">
      ${B(s.summary)}
    </section>
    <section class="body-grid">
      <article class="card chart-card">
        <div class="card-heading">
          <div>
            <h2>30-day Visitors</h2>
            <p>Hand-drawn SVG line chart</p>
          </div>
        </div>
        <div id="chartHost" class="chart-host" role="img" aria-label="30-day visitors line chart"></div>
      </article>
      <article class="card breakdown-card">
        <div class="card-heading">
          <div>
            <h2>Category Breakdown</h2>
            <p>Revenue contribution by segment</p>
          </div>
        </div>
        <div class="bars" id="barsHost">${U()}</div>
      </article>
    </section>
    <section class="card table-card">
      <div class="card-heading">
        <div>
          <h2>Recent Items</h2>
          <p>Latest seeded activity</p>
        </div>
      </div>
      ${z()}
    </section>
  `,G()}function U(){const e=Math.max(...s.categories.map(t=>t.value),1);return s.categories.map(t=>{const r=Math.max(6,t.value/e*100);return`
      <div class="bar-row">
        <div class="bar-topline">
          <span class="bar-label" title="${c(t.label)}">${c(t.label)}</span>
          <span class="bar-value">${g.format(t.value)}</span>
        </div>
        <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${r}%"></div></div>
      </div>
    `}).join("")}function z(){return`
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Name</th><th>Category</th><th>Value</th><th>Date</th></tr>
        </thead>
        <tbody>
          ${s.recent.map(e=>`
            <tr>
              <td data-label="Name"><span class="cell-main">${c(e.name)}</span></td>
              <td data-label="Category"><span class="truncate" title="${c(e.category)}">${c(e.category)}</span></td>
              <td data-label="Value">${x.format(e.value)}</td>
              <td data-label="Date">${F.format(new Date(e.createdAt))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `}function m(e){return getComputedStyle(document.documentElement).getPropertyValue(e).trim()}function G(){p&&p.disconnect();const e=document.querySelector("#chartHost");e&&(p=new ResizeObserver(t=>{for(const r of t){const{width:a}=r.contentRect;k(e,Math.max(0,Math.floor(a)))}}),p.observe(e),requestAnimationFrame(()=>k(e,Math.floor(e.getBoundingClientRect().width))))}function k(e,t){if(!e||!s.timeseries.length||t<=0)return;const r=t<430?260:320,a={top:22,right:t<420?12:22,bottom:t<420?54:48,left:t<420?46:58},n=Math.max(24,t-a.left-a.right),o=Math.max(80,r-a.top-a.bottom),d=s.timeseries.map(i=>i.visitors),D=Math.min(...d),T=Math.max(...d),w=Math.max(10,(T-D)*.12),f=Math.max(0,Math.floor((D-w)/100)*100),v=Math.ceil((T+w)/100)*100,y=i=>a.left+(s.timeseries.length===1?n/2:i/(s.timeseries.length-1)*n),$=i=>a.top+(1-(i-f)/(v-f||1))*o,S=s.timeseries.map((i,l)=>`${y(l).toFixed(1)},${$(i.visitors).toFixed(1)}`).join(" "),C=[0,.25,.5,.75,1].map(i=>Math.round(v-i*(v-f))),H=t<420?[0,14,29]:[0,7,14,21,29],b=m("--axis"),A=m("--grid"),M=m("--muted"),L=m("--series"),j=m("--series-fill"),I=`${a.left},${a.top+o} ${S} ${a.left+n},${a.top+o}`;e.innerHTML=`
    <svg class="line-chart" viewBox="0 0 ${t} ${r}" width="100%" height="${r}" role="presentation" preserveAspectRatio="none">
      <rect x="0" y="0" width="${t}" height="${r}" fill="transparent"></rect>
      ${C.map(i=>{const l=$(i);return`<g><line x1="${a.left}" x2="${a.left+n}" y1="${l}" y2="${l}" stroke="${A}" stroke-width="1"/><text x="${a.left-8}" y="${l+4}" text-anchor="end" fill="${M}" font-size="11">${N.format(i)}</text></g>`}).join("")}
      <line x1="${a.left}" x2="${a.left}" y1="${a.top}" y2="${a.top+o}" stroke="${b}" stroke-width="1.2"/>
      <line x1="${a.left}" x2="${a.left+n}" y1="${a.top+o}" y2="${a.top+o}" stroke="${b}" stroke-width="1.2"/>
      ${H.map(i=>{const l=y(i);return`<g><line x1="${l}" x2="${l}" y1="${a.top+o}" y2="${a.top+o+5}" stroke="${b}"/><text x="${l}" y="${a.top+o+22}" text-anchor="middle" fill="${M}" font-size="11">${q(s.timeseries[i].date)}</text></g>`}).join("")}
      <polygon points="${I}" fill="${j}" opacity="0.34"></polygon>
      <polyline points="${S}" fill="none" stroke="${L}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${s.timeseries.map((i,l)=>`<circle cx="${y(l).toFixed(1)}" cy="${$(i.visitors).toFixed(1)}" r="${t<420?2.4:3.2}" fill="${L}"><title>${i.date}: ${g.format(i.visitors)} visitors</title></circle>`).join("")}
    </svg>
  `}async function J(){const e=s.theme,t=e==="dark"?"light":"dark";u(t);try{const r=await h("/api/settings",{method:"PUT",body:JSON.stringify({theme:t})});u(r.theme)}catch{u(e),alert("Could not persist theme preference. Is the backend running?")}}function u(e){s.theme=e==="dark"?"dark":"light",document.documentElement.dataset.theme=s.theme;const t=document.querySelector("#themeLabel");t&&(t.textContent=s.theme==="dark"?"Dark":"Light");const r=document.querySelector("#themeToggle");r&&r.setAttribute("aria-label",`Switch to ${s.theme==="dark"?"light":"dark"} theme`);const a=document.querySelector("#chartHost");a&&k(a,Math.floor(a.getBoundingClientRect().width))}async function R(){const e=document.querySelector("#dashboard");e&&(e.innerHTML='<section class="loading-card">Loading dashboard data…</section>');try{const[t,r,a,n,o]=await Promise.all([h("/api/settings"),h("/api/summary"),h("/api/timeseries"),h("/api/categories"),h("/api/recent")]);s={...s,theme:t.theme,summary:r,timeseries:a,categories:n,recent:o},u(t.theme),E()}catch(t){V(t)}}O();u(s.theme);R();
