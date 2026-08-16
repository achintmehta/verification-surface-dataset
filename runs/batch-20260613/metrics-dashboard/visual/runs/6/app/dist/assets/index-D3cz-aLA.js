(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))o(s);new MutationObserver(s=>{for(const c of s)if(c.type==="childList")for(const r of c.addedNodes)r.tagName==="LINK"&&r.rel==="modulepreload"&&o(r)}).observe(document,{childList:!0,subtree:!0});function a(s){const c={};return s.integrity&&(c.integrity=s.integrity),s.referrerPolicy&&(c.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?c.credentials="include":s.crossOrigin==="anonymous"?c.credentials="omit":c.credentials="same-origin",c}function o(s){if(s.ep)return;s.ep=!0;const c=a(s);fetch(s.href,c)}})();const m="/api",E=document.querySelector("#app"),x=new Intl.NumberFormat("en-US"),k=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}),H=new Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:1}),U=new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric"}),F=new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric"});let h=null,y=null;B();async function B(){z();try{const e=await u(`${m}/settings`);N(e.theme),document.documentElement.classList.remove("theme-loading");const[t,a,o,s]=await Promise.all([u(`${m}/summary`),u(`${m}/timeseries`),u(`${m}/categories`),u(`${m}/recent`)]);h={summary:t,timeseries:a,categories:o,recent:s},J(h)}catch(e){console.error(e),document.documentElement.classList.remove("theme-loading"),Z(e)}}async function u(e,t){const a=await fetch(e,{headers:{"Content-Type":"application/json"},...t});if(!a.ok)throw new Error(`Request failed: ${a.status} ${a.statusText}`);return a.json()}function z(){E.innerHTML=`
    <div class="page-shell">
      <header class="topbar">
        <div class="title-wrap">
          <p class="eyebrow">Read-mostly analytics</p>
          <h1>Metrics Dashboard</h1>
        </div>
        <button class="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="false">
          <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
          <span class="toggle-text">Light</span>
        </button>
      </header>
      <main id="content" class="content" aria-live="polite">
        <section class="loading-state card">Loading dashboard metrics…</section>
      </main>
    </div>
  `,document.querySelector(".theme-toggle").addEventListener("click",W)}function J(e){const{summary:t}=e,a=document.querySelector("#content");a.innerHTML=`
    <section class="stats-grid" aria-label="Summary metrics">
      ${f("Total visitors",x.format(t.totalVisitors),"30-day total","up")}
      ${f("Total revenue",k.format(t.totalRevenue),"30-day total","up")}
      ${f("Best day",x.format(t.bestDay.visitors),`${F.format(O(t.bestDay.date))} visitors`,"up")}
      ${f("7-day trend",`${t.sevenDayTrendPct>=0?"+":""}${t.sevenDayTrendPct.toFixed(1)}%`,"vs prior 7 days",t.sevenDayTrendPct>=0?"up":"down")}
    </section>

    <section class="body-grid">
      <article class="card chart-card">
        <div class="card-head">
          <div>
            <h2>30-day visitors</h2>
            <p>Daily traffic trend</p>
          </div>
        </div>
        <div id="lineChart" class="chart-box" role="img" aria-label="Line chart of daily visitors over 30 days"></div>
      </article>

      <article class="card category-card">
        <div class="card-head">
          <div>
            <h2>Category breakdown</h2>
            <p>Seeded category values</p>
          </div>
        </div>
        <div class="bars" id="categoryBars"></div>
      </article>
    </section>

    <section class="card table-card">
      <div class="card-head">
        <div>
          <h2>Recent items</h2>
          <p>Latest seeded records from PGLite</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Category</th><th scope="col">Value</th><th scope="col">Created</th></tr>
          </thead>
          <tbody id="recentRows"></tbody>
        </table>
      </div>
    </section>
  `,V(e.categories),G(e.recent),K(e.timeseries)}function f(e,t,a,o){return`
    <article class="card stat-card">
      <span class="stat-label">${l(e)}</span>
      <strong class="stat-value">${l(t)}</strong>
      <span class="stat-meta ${o==="down"?"negative":"positive"}">
        <span aria-hidden="true">${o==="down"?"↘":"↗"}</span>${l(a)}
      </span>
    </article>
  `}function V(e){const t=Math.max(...e.map(a=>a.value),1);document.querySelector("#categoryBars").innerHTML=e.map(a=>{const o=Math.max(7,a.value/t*100);return`
      <div class="bar-row">
        <div class="bar-top">
          <span class="bar-label" title="${l(a.label)}">${l(a.label)}</span>
          <span class="bar-value">${x.format(a.value)}</span>
        </div>
        <div class="bar-track"><span class="bar-fill" style="width:${o}%"></span></div>
      </div>
    `}).join("")}function G(e){document.querySelector("#recentRows").innerHTML=e.map(t=>`
    <tr>
      <td data-label="Name"><span class="cell-primary">${l(t.name)}</span></td>
      <td data-label="Category"><span class="truncate">${l(t.category)}</span></td>
      <td data-label="Value">${k.format(t.value)}</td>
      <td data-label="Created">${F.format(new Date(t.createdAt))}</td>
    </tr>
  `).join("")}function K(e){const t=document.querySelector("#lineChart"),a=()=>q(t,e);y&&y.disconnect(),y=new ResizeObserver(a),y.observe(t),a()}function q(e,t){const a=e.getBoundingClientRect(),o=Math.max(280,Math.floor(a.width)),s=Math.max(260,Math.floor(a.height||320)),c=o<430,r=c?{top:18,right:28,bottom:44,left:43}:{top:22,right:20,bottom:50,left:56},P=Math.max(1,o-r.left-r.right),R=Math.max(1,s-r.top-r.bottom),d=t.map(n=>({...n,dateObj:O(n.date),visitors:Number(n.visitors)})),w=d.map(n=>n.visitors),L=Math.min(...w),S=Math.max(...w),T=Math.max(80,(S-L)*.12),p=Math.max(0,Math.floor((L-T)/100)*100),M=Math.ceil((S+T)/100)*100,g=n=>r.left+(d.length===1?0:n/(d.length-1)*P),b=n=>r.top+(1-(n-p)/(M-p||1))*R,D=4,v=[];for(let n=0;n<=D;n+=1){const i=p+(M-p)/D*n,$=b(i);v.push(`<line class="grid-line" x1="${r.left}" y1="${$}" x2="${o-r.right}" y2="${$}"/>`),v.push(`<text class="axis-label y-label" x="${r.left-8}" y="${$+4}" text-anchor="end">${H.format(Math.round(i))}</text>`)}const A=(c?[0,14,29]:[0,7,14,21,29]).map(n=>{const i=g(n);return`<line class="tick-line" x1="${i}" y1="${s-r.bottom}" x2="${i}" y2="${s-r.bottom+5}"/>
      <text class="axis-label" x="${i}" y="${s-r.bottom+22}" text-anchor="middle">${U.format(d[n].dateObj)}</text>`}).join(""),C=d.map((n,i)=>`${i===0?"M":"L"} ${g(i).toFixed(2)} ${b(n.visitors).toFixed(2)}`).join(" "),I=`${C} L ${g(d.length-1).toFixed(2)} ${s-r.bottom} L ${r.left} ${s-r.bottom} Z`,j=d.map((n,i)=>`<circle class="series-dot" cx="${g(i).toFixed(2)}" cy="${b(n.visitors).toFixed(2)}" r="${c?2.2:2.8}"></circle>`).join("");e.innerHTML=`
    <svg class="line-svg" viewBox="0 0 ${o} ${s}" width="100%" height="100%" preserveAspectRatio="none" focusable="false" aria-hidden="true">
      <rect class="plot-bg" x="0" y="0" width="${o}" height="${s}" rx="14"></rect>
      <g>${v.join("")}</g>
      <line class="axis-line" x1="${r.left}" y1="${s-r.bottom}" x2="${o-r.right}" y2="${s-r.bottom}"/>
      <line class="axis-line" x1="${r.left}" y1="${r.top}" x2="${r.left}" y2="${s-r.bottom}"/>
      <g>${A}</g>
      <path class="area-fill" d="${I}"></path>
      <path class="series-line" d="${C}"></path>
      <g>${j}</g>
    </svg>
  `}async function W(){const e=document.documentElement.dataset.theme==="dark"?"light":"dark";N(e);try{await u(`${m}/settings`,{method:"PUT",body:JSON.stringify({theme:e})})}catch(t){console.error(t),Q("Theme changed locally, but saving failed.")}h!=null&&h.timeseries&&q(document.querySelector("#lineChart"),h.timeseries)}function N(e){const t=e==="dark"?"dark":"light";document.documentElement.dataset.theme=t;const a=document.querySelector(".theme-toggle");a&&(a.setAttribute("aria-pressed",String(t==="dark")),a.querySelector(".toggle-text").textContent=t==="dark"?"Dark":"Light")}function Z(e){const t=document.querySelector("#content");t.innerHTML=`
    <section class="empty-state card" role="alert">
      <h2>Dashboard data unavailable</h2>
      <p>The dashboard renders only from the JSON API. Start the backend server and reload this page.</p>
      <code>${l(e.message)}</code>
    </section>
  `}function Q(e){const t=document.createElement("div");t.className="toast",t.textContent=e,document.body.appendChild(t),setTimeout(()=>t.remove(),3500)}function O(e){const[t,a,o]=String(e).slice(0,10).split("-").map(Number);return new Date(t,a-1,o)}function l(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}
