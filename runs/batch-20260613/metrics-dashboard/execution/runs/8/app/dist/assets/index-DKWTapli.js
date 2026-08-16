(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))i(s);new MutationObserver(s=>{for(const r of s)if(r.type==="childList")for(const c of r.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&i(c)}).observe(document,{childList:!0,subtree:!0});function a(s){const r={};return s.integrity&&(r.integrity=s.integrity),s.referrerPolicy&&(r.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?r.credentials="include":s.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function i(s){if(s.ep)return;s.ep=!0;const r=a(s);fetch(s.href,r)}})();const P=document.querySelector("#app"),$=new Intl.NumberFormat("en-US"),E=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}),x=new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",timeZone:"UTC"});let b=null,v=null,y=null;function F(t){document.documentElement.dataset.theme=t==="dark"?"dark":"light";const e=document.querySelector('meta[name="color-scheme"]');e&&(e.content=t==="dark"?"dark light":"light dark"),v&&v.draw()}async function u(t,e){const a=await fetch(t,{headers:{"Content-Type":"application/json",...(e==null?void 0:e.headers)||{}},...e});if(!a.ok)throw new Error(`${t} returned ${a.status}`);return a.json()}function g(t,e,a,i=""){return`
    <article class="card stat-card">
      <div class="stat-label">${t}</div>
      <div class="stat-value">${e}</div>
      <div class="stat-subtext ${i}">${a}</div>
    </article>
  `}function A(t){const e=t.summary.sevenDayTrendPct>=0?"positive":"negative",a=t.summary.sevenDayTrendPct>=0?"+":"";P.innerHTML=`
    <header class="page-header">
      <div class="header-copy">
        <p class="eyebrow">Read-mostly analytics</p>
        <h1>Metrics Dashboard</h1>
        <p class="lede">Seeded PostgreSQL metrics rendered with responsive, hand-drawn charts.</p>
      </div>
      <button id="themeToggle" class="theme-toggle" type="button" aria-pressed="${t.settings.theme==="dark"}">
        <span class="toggle-icon" aria-hidden="true">${t.settings.theme==="dark"?"☾":"☼"}</span>
        <span>${t.settings.theme==="dark"?"Dark":"Light"} theme</span>
      </button>
    </header>

    <main class="dashboard" aria-live="polite">
      <section class="stats-grid" aria-label="Summary statistics">
        ${g("Total visitors",$.format(t.summary.totalVisitors),"30-day audience")}
        ${g("Total revenue",E.format(t.summary.totalRevenue),"Seeded deterministic revenue")}
        ${g("Best day",x.format(new Date(`${t.summary.bestDay.date}T00:00:00Z`)),`${$.format(t.summary.bestDay.visitors)} visitors`)}
        ${g("7-day trend",`${a}${t.summary.sevenDayTrendPct}%`,"vs previous 7 days",e)}
      </section>

      <section class="content-grid">
        <article class="card chart-card">
          <div class="card-heading">
            <div>
              <h2>30-day visitors</h2>
              <p>Line chart redraws from SVG coordinates on resize.</p>
            </div>
          </div>
          <div id="lineChart" class="line-chart" role="img" aria-label="30 day visitor time series"></div>
        </article>

        <article class="card breakdown-card">
          <div class="card-heading">
            <div>
              <h2>Category breakdown</h2>
              <p>Labels truncate independently from bars.</p>
            </div>
          </div>
          <div class="bars" aria-label="Category values">
            ${t.categories.map(H).join("")}
          </div>
        </article>
      </section>

      <section class="card table-card">
        <div class="card-heading">
          <div>
            <h2>Recent items</h2>
            <p>Latest 20 seeded records.</p>
          </div>
        </div>
        ${I(t.recent)}
      </section>
    </main>
  `,document.querySelector("#themeToggle").addEventListener("click",R);const i=document.querySelector("#lineChart");v=U(i,t.timeseries),y&&y.disconnect(),y=new ResizeObserver(()=>v.draw()),y.observe(i),v.draw()}function H(t){const e=Math.max(...b.categories.map(i=>i.value)),a=Math.max(7,t.value/e*100);return`
    <div class="bar-row">
      <div class="bar-meta">
        <span class="bar-label" title="${h(t.label)}">${h(t.label)}</span>
        <span class="bar-value">${$.format(t.value)}</span>
      </div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${a}%"></div></div>
    </div>
  `}function I(t){return`
    <div class="responsive-table" role="table" aria-label="Recent items">
      <div class="table-row table-head" role="row">
        <div role="columnheader">Name</div>
        <div role="columnheader">Category</div>
        <div role="columnheader">Value</div>
        <div role="columnheader">Created</div>
      </div>
      ${t.map(e=>`
        <div class="table-row" role="row">
          <div class="item-name" role="cell" data-label="Name">${h(e.name)}</div>
          <div role="cell" data-label="Category"><span class="pill" title="${h(e.category)}">${h(e.category)}</span></div>
          <div class="numeric" role="cell" data-label="Value">${E.format(e.value)}</div>
          <div role="cell" data-label="Created">${x.format(new Date(e.createdAt))}</div>
        </div>
      `).join("")}
    </div>
  `}function h(t){return String(t).replace(/[&<>'"]/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[e])}async function R(){const e=document.documentElement.dataset.theme==="dark"?"light":"dark";F(e);const a=document.querySelector("#themeToggle");a.disabled=!0,a.setAttribute("aria-pressed",String(e==="dark")),a.innerHTML=`<span class="toggle-icon" aria-hidden="true">${e==="dark"?"☾":"☼"}</span><span>${e==="dark"?"Dark":"Light"} theme</span>`;try{await u("/api/settings",{method:"PUT",body:JSON.stringify({theme:e})})}catch{z("Theme changed locally, but could not be persisted.")}finally{a.disabled=!1}}function z(t){let e=document.querySelector(".toast");e||(e=document.createElement("div"),e.className="toast",document.body.appendChild(e)),e.textContent=t,e.classList.add("visible"),setTimeout(()=>e.classList.remove("visible"),3200)}function m(t){return getComputedStyle(document.documentElement).getPropertyValue(t).trim()}function U(t,e){return{draw(){const a=Math.max(280,Math.floor(t.clientWidth)),i=Math.max(260,Math.floor(t.clientHeight||320)),s=a<430,r={top:20,right:s?12:22,bottom:s?48:44,left:s?44:58},c=Math.max(10,a-r.left-r.right),n=Math.max(10,i-r.top-r.bottom),w=e.map(o=>o.visitors),f=Math.floor(Math.min(...w)/100)*100,k=Math.ceil(Math.max(...w)/100)*100-f||1,d=o=>r.left+(e.length===1?c/2:o/(e.length-1)*c),p=o=>r.top+n-(o-f)/k*n,T=e.map((o,l)=>`${l===0?"M":"L"} ${d(l).toFixed(2)} ${p(o.visitors).toFixed(2)}`).join(" "),N=`${T} L ${d(e.length-1).toFixed(2)} ${r.top+n} L ${r.left} ${r.top+n} Z`,C=m("--muted"),L=m("--grid"),S=m("--axis"),M=m("--series"),j=m("--series-fill"),D=s?10:11,O=Array.from({length:5},(o,l)=>f+k*l/4),q=s?[0,14,29]:[0,7,14,21,29];t.innerHTML=`
        <svg class="chart-svg" viewBox="0 0 ${a} ${i}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
          <rect x="0" y="0" width="${a}" height="${i}" fill="transparent"></rect>
          ${O.map(o=>`
            <line x1="${r.left}" x2="${a-r.right}" y1="${p(o)}" y2="${p(o)}" stroke="${L}" stroke-width="1" />
            <text x="${r.left-8}" y="${p(o)+4}" text-anchor="end" font-size="${D}" fill="${C}">${$.format(Math.round(o))}</text>
          `).join("")}
          ${q.map(o=>`
            <line x1="${d(o)}" x2="${d(o)}" y1="${r.top}" y2="${r.top+n}" stroke="${L}" stroke-width="1" />
            <text x="${d(o)}" y="${i-16}" text-anchor="middle" font-size="${D}" fill="${C}">${x.format(new Date(`${e[o].date}T00:00:00Z`))}</text>
          `).join("")}
          <line x1="${r.left}" x2="${r.left}" y1="${r.top}" y2="${r.top+n}" stroke="${S}" stroke-width="1.25" />
          <line x1="${r.left}" x2="${a-r.right}" y1="${r.top+n}" y2="${r.top+n}" stroke="${S}" stroke-width="1.25" />
          <path d="${N}" fill="${j}" />
          <path d="${T}" fill="none" stroke="${M}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          ${e.map((o,l)=>l%(s?5:3)===0||l===e.length-1?`<circle cx="${d(l)}" cy="${p(o.visitors)}" r="3" fill="${M}" stroke="${m("--card")}" stroke-width="1.5" />`:"").join("")}
        </svg>
      `}}}function V(t){P.innerHTML=`
    <main class="error-state">
      <section class="card error-card">
        <p class="eyebrow">Dashboard unavailable</p>
        <h1>Could not load API data</h1>
        <p>The dashboard intentionally renders only from live API responses. Start the backend server and reload this page.</p>
        <pre>${h(t.message)}</pre>
        <button type="button" onclick="location.reload()">Retry</button>
      </section>
    </main>
  `}async function Z(){try{const t=await u("/api/settings");F(t.theme),document.documentElement.classList.remove("theme-pending");const[e,a,i,s]=await Promise.all([u("/api/summary"),u("/api/timeseries"),u("/api/categories"),u("/api/recent")]);b={settings:t,summary:e,timeseries:a,categories:i,recent:s},A(b)}catch(t){document.documentElement.classList.remove("theme-pending"),V(t)}}Z();
