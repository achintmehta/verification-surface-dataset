(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))a(r);new MutationObserver(r=>{for(const n of r)if(n.type==="childList")for(const o of n.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&a(o)}).observe(document,{childList:!0,subtree:!0});function i(r){const n={};return r.integrity&&(n.integrity=r.integrity),r.referrerPolicy&&(n.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?n.credentials="include":r.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function a(r){if(r.ep)return;r.ep=!0;const n=i(r);fetch(r.href,n)}})();const x=document.querySelector("#app"),P=e=>`/api${e}`,s={summary:null,timeseries:[],categories:[],recent:[],theme:"light",error:null,chartResizeObserver:null},h=new Intl.NumberFormat("en-US"),b=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}),z={format(e){return e>=1e3?`${(e/1e3).toFixed(e>=1e4?0:1)}K`:String(Math.round(e))}},w=new Intl.NumberFormat("en-US",{maximumFractionDigits:1,minimumFractionDigits:1});async function m(e,t={}){const i=await fetch(P(e),{headers:{"Content-Type":"application/json"},...t});if(!i.ok)throw new Error(`${e} failed (${i.status})`);return i.json()}function g(e){s.theme=e==="dark"?"dark":"light",document.documentElement.dataset.theme=s.theme;const t=document.querySelector('meta[name="color-scheme"]');t&&(t.content=s.theme);const i=document.querySelector("#theme-toggle");i&&(i.checked=s.theme==="dark",i.setAttribute("aria-label",`Switch to ${s.theme==="dark"?"light":"dark"} theme`)),u()}function D(e){return getComputedStyle(document.documentElement).getPropertyValue(e).trim()}async function C(){try{const e=await m("/settings");g(e.theme);const[t,i,a,r]=await Promise.all([m("/summary"),m("/timeseries"),m("/categories"),m("/recent")]);Object.assign(s,{summary:t,timeseries:i,categories:a,recent:r,error:null})}catch(e){console.error(e),s.error="Unable to load dashboard data. Start the metrics API server and reload this page."}finally{S()}}function j(){var r,n;const e=s.summary,t=e.sevenDayTrendPercent,i=t>=0?"up":"down",a=T(e.bestDay.date);return[{label:"Total Visitors",value:h.format(e.totalVisitors),sub:"30-day cumulative traffic",trend:`${w.format(t)}% 7-day`,direction:i},{label:"Total Revenue",value:b.format(e.totalRevenue),sub:"Seeded deterministic revenue",trend:`${w.format(t*.72)}% pace`,direction:i},{label:"Best Day",value:h.format(e.bestDay.visitors),sub:`${a} by visitors`,trend:b.format(e.bestDay.revenue),direction:"neutral"},{label:"Largest Segment",value:h.format(((r=s.categories[0])==null?void 0:r.value)??0),sub:((n=s.categories[0])==null?void 0:n.label)??"No category",trend:"7-digit value check",direction:"neutral"}].map(o=>`
    <article class="stat-card card">
      <div class="stat-label">${l(o.label)}</div>
      <div class="stat-value" title="${l(o.value)}">${l(o.value)}</div>
      <div class="stat-footer">
        <span class="stat-sub" title="${l(o.sub)}">${l(o.sub)}</span>
        <span class="trend ${o.direction}">${l(o.trend)}</span>
      </div>
    </article>
  `).join("")}function S(){var t;if(s.chartResizeObserver&&(s.chartResizeObserver.disconnect(),s.chartResizeObserver=null),s.error){x.innerHTML=`
      <main class="shell">
        <header class="topbar">
          <div><p class="eyebrow">Metrics Dashboard</p><h1>Dashboard unavailable</h1></div>
        </header>
        <section class="error-state card" role="alert">
          <h2>Could not connect to the metrics API</h2>
          <p>${l(s.error)}</p>
        </section>
      </main>`;return}x.innerHTML=`
    <main class="shell">
      <header class="topbar">
        <div class="title-block">
          <p class="eyebrow">Metrics Dashboard</p>
          <h1>Executive overview</h1>
          <p class="lede">30 days of seeded product, revenue, and category activity.</p>
        </div>
        <label class="theme-switch">
          <span>Light</span>
          <input id="theme-toggle" type="checkbox" ${s.theme==="dark"?"checked":""} />
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
          <span>Dark</span>
        </label>
      </header>

      <section class="stats-grid" aria-label="Summary statistics">${j()}</section>

      <section class="dashboard-grid">
        <article class="card chart-card">
          <div class="card-heading">
            <div><h2>Visitor trend</h2><p>Daily visitors across the last 30 days</p></div>
            <span class="badge">SVG / responsive</span>
          </div>
          <div id="line-chart" class="line-chart" role="img" aria-label="30 day visitor time-series chart"></div>
        </article>

        <article class="card category-card">
          <div class="card-heading"><div><h2>Category breakdown</h2><p>Revenue influence by segment</p></div></div>
          <div class="bar-list">${q()}</div>
        </article>

        <article class="card table-card">
          <div class="card-heading"><div><h2>Recent items</h2><p>Latest seeded account activity</p></div></div>
          ${A()}
        </article>
      </section>
    </main>`,(t=document.querySelector("#theme-toggle"))==null||t.addEventListener("change",N),g(s.theme),u();const e=document.querySelector("#line-chart");e&&"ResizeObserver"in window?(s.chartResizeObserver=new ResizeObserver(()=>u()),s.chartResizeObserver.observe(e)):window.addEventListener("resize",u,{passive:!0})}async function N(e){const t=e.currentTarget.checked?"dark":"light";g(t);try{await m("/settings",{method:"PUT",body:JSON.stringify({theme:t})})}catch(i){console.error(i),s.error="Theme preference could not be saved because the metrics API is unavailable.",S()}}function q(){const e=Math.max(...s.categories.map(t=>t.value),1);return s.categories.map(t=>`
    <div class="bar-row">
      <div class="bar-meta">
        <span class="bar-label" title="${l(t.label)}">${l(t.label)}</span>
        <span class="bar-value">${h.format(t.value)}</span>
      </div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${Math.max(5,t.value/e*100).toFixed(2)}%"></div></div>
    </div>
  `).join("")}function A(){return`
    <div class="table-wrap">
      <table>
        <thead><tr><th>Item</th><th>Category</th><th>Value</th><th>Date</th></tr></thead>
        <tbody>${s.recent.map(e=>`
          <tr>
            <td data-label="Item"><span class="cell-main" title="${l(e.name)}">${l(e.name)}</span></td>
            <td data-label="Category"><span class="cell-muted" title="${l(e.category)}">${l(e.category)}</span></td>
            <td data-label="Value">${b.format(e.value)}</td>
            <td data-label="Date">${T(e.created_at)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`}function u(){const e=document.querySelector("#line-chart");if(!e||!s.timeseries.length)return;const t=Math.max(260,Math.floor(e.clientWidth)),i=Math.max(250,Math.floor(Math.min(380,Math.max(260,t*.48)))),a=t<420?{top:18,right:16,bottom:52,left:46}:{top:20,right:24,bottom:56,left:58},r=Math.max(10,t-a.left-a.right),n=Math.max(10,i-a.top-a.bottom),o=s.timeseries.map(c=>Number(c.visitors)),p=Math.floor(Math.min(...o)*.94/100)*100,k=Math.ceil(Math.max(...o)*1.04/100)*100,v=Math.max(1,k-p),f=c=>a.left+c/(o.length-1)*r,y=c=>a.top+(1-(c-p)/v)*n,$=o.map((c,d)=>`${f(d).toFixed(2)},${y(c).toFixed(2)}`).join(" "),O=`${a.left},${a.top+n} ${$} ${a.left+r},${a.top+n}`,L=[0,.25,.5,.75,1].map(c=>Math.round((p+v*c)/100)*100),F=t<420?[0,14,29]:[0,7,14,21,29],I=L.map(c=>{const d=y(c);return`<g><line class="grid-line" x1="${a.left}" x2="${a.left+r}" y1="${d}" y2="${d}"/><text class="axis-label" x="${a.left-9}" y="${d+4}" text-anchor="end">${z.format(c)}</text></g>`}).join(""),R=F.map(c=>{const d=f(c);return`<g><line class="tick-line" x1="${d}" x2="${d}" y1="${a.top+n}" y2="${a.top+n+6}"/><text class="axis-label" x="${d}" y="${i-20}" text-anchor="middle">${U(s.timeseries[c].date)}</text></g>`}).join("");e.innerHTML=`
    <svg viewBox="0 0 ${t} ${i}" width="100%" height="${i}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="chartArea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${D("--series")}" stop-opacity="0.30"/>
          <stop offset="100%" stop-color="${D("--series")}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <rect class="plot-bg" x="${a.left}" y="${a.top}" width="${r}" height="${n}" rx="10"/>
      ${I}
      <line class="axis-line" x1="${a.left}" x2="${a.left}" y1="${a.top}" y2="${a.top+n}"/>
      <line class="axis-line" x1="${a.left}" x2="${a.left+r}" y1="${a.top+n}" y2="${a.top+n}"/>
      ${R}
      <polygon points="${O}" fill="url(#chartArea)"/>
      <polyline class="series-line" points="${$}" fill="none"/>
      <circle class="series-dot" cx="${f(o.length-1)}" cy="${y(o[o.length-1])}" r="4"/>
    </svg>`}function l(e){return String(e).replace(/[&<>'"]/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[t])}function M(e){const t=String(e),i=/^\d{4}-\d{2}-\d{2}$/.test(t)?`${t}T12:00:00`:t.replace(" ","T").replace(/([+-]\d{2})$/,"$1:00");return new Date(i)}function T(e){return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric"}).format(M(e))}function U(e){return new Intl.DateTimeFormat("en-US",{month:"numeric",day:"numeric"}).format(M(e))}C();
