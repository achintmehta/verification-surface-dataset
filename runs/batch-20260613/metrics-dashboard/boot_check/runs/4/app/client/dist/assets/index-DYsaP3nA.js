(function(){const n=document.createElement("link").relList;if(n&&n.supports&&n.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))a(r);new MutationObserver(r=>{for(const o of r)if(o.type==="childList")for(const c of o.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&a(c)}).observe(document,{childList:!0,subtree:!0});function i(r){const o={};return r.integrity&&(o.integrity=r.integrity),r.referrerPolicy&&(o.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?o.credentials="include":r.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function a(r){if(r.ep)return;r.ep=!0;const o=i(r);fetch(r.href,o)}})();(async()=>{try{const t=await fetch("/api/settings");if(t.ok){const{theme:n}=await t.json();document.documentElement.setAttribute("data-theme",n)}}catch{document.documentElement.setAttribute("data-theme","light")}})();function O(t){return t==null?"—":new Intl.NumberFormat("en-US").format(Math.round(t))}function B(t){return t==null?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:0,maximumFractionDigits:0}).format(t)}function R(t){return t?new Date(t).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):"—"}function W(t){return t>0?`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15"/>
    </svg>`:t<0?`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>`:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>`}function z(t){return t>0?"trend--up":t<0?"trend--down":"trend--neutral"}const b={visitors:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>`,revenue:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="1" x2="12" y2="23"/>
    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
  </svg>`,bestDay:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/>
    <line x1="8" y1="2" x2="8" y2="6"/>
    <line x1="3" y1="10" x2="21" y2="10"/>
  </svg>`,trend:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
    <polyline points="16 7 22 7 22 13"/>
  </svg>`};function q(t){const n=document.getElementById("stat-cards");if(!n||!t)return;const{totalVisitors:i,totalRevenue:a,bestDay:r,trendPct:o}=t,c=[{id:"card-visitors",icon:b.visitors,label:"Total Visitors",value:O(i),trend:null,sub:"Last 30 days"},{id:"card-revenue",icon:b.revenue,label:"Total Revenue",value:B(a),trend:null,sub:"Last 30 days"},{id:"card-bestday",icon:b.bestDay,label:"Best Day Revenue",value:r?B(r.revenue):"—",trend:null,sub:r?R(r.date):""},{id:"card-trend",icon:b.trend,label:"7-Day Trend",value:`${o>=0?"+":""}${o.toFixed(1)}%`,trend:o,sub:"vs. prior 7 days"}];n.innerHTML=c.map(e=>`
    <div class="stat-card" id="${e.id}">
      <div class="stat-card__icon">${e.icon}</div>
      <div class="stat-card__label">${e.label}</div>
      <div class="stat-card__value">${e.value}</div>
      ${e.trend!==null?`<div class="stat-card__trend ${z(e.trend)}">
            ${W(e.trend)}
            <span>${Math.abs(e.trend).toFixed(1)}% vs prior week</span>
          </div>`:`<div class="stat-card__sub">${e.sub}</div>`}
    </div>
  `).join("")}function J(t){return t>=1e6?new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",notation:"compact",maximumFractionDigits:2}).format(t):new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:0,maximumFractionDigits:0}).format(t)}function X(t){const n=document.getElementById("categories-list");if(!n||!t||t.length===0){n&&(n.innerHTML='<p style="color: var(--color-text-muted); font-size: 0.875rem;">No categories available.</p>');return}const i=Math.max(...t.map(a=>a.value));n.innerHTML=t.map(a=>{const r=i>0?a.value/i*100:0,o=J(a.value);return`
      <div class="category-item">
        <div class="category-item__header">
          <span class="category-item__name" title="${S(a.name)}">${S(a.name)}</span>
          <span class="category-item__value">${o}</span>
        </div>
        <div class="category-item__bar-track" role="progressbar" aria-valuenow="${Math.round(r)}" aria-valuemin="0" aria-valuemax="100" aria-label="${S(a.name)}: ${o}">
          <div class="category-item__bar-fill" style="width: ${r.toFixed(2)}%"></div>
        </div>
      </div>
    `}).join("")}function S(t){return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function G(t){return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:2}).format(t)}function K(t){return t?new Date(t).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):"—"}function w(t){return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function Y(t){const n=document.getElementById("recent-tbody");if(n){if(!t||t.length===0){n.innerHTML=`
      <tr>
        <td colspan="4" style="text-align: center; color: var(--color-text-muted); padding: 2rem;">
          No recent items found.
        </td>
      </tr>
    `;return}n.innerHTML=t.map(i=>`
    <tr>
      <td class="td-name" title="${w(i.name)}">${w(i.name)}</td>
      <td class="td-category" title="${w(i.category)}">${w(i.category)}</td>
      <td class="td-value text-right">${G(i.value)}</td>
      <td class="td-date text-right">${K(i.createdAt)}</td>
    </tr>
  `).join("")}}class Z{constructor(n,i){this.canvas=n,this.data=i||[],this.dpr=window.devicePixelRatio||1,this._onThemeChange=()=>this.draw(),window.addEventListener("themechange",this._onThemeChange)}destroy(){window.removeEventListener("themechange",this._onThemeChange)}_cssVar(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}draw(){const n=this.canvas,i=n.parentElement;if(!i)return;const a=i.getBoundingClientRect(),r=Math.floor(a.width),o=Math.floor(a.height);if(r<=0||o<=0)return;const c=this.dpr;n.width=r*c,n.height=o*c,n.style.width=r+"px",n.style.height=o+"px";const e=n.getContext("2d");e.scale(c,c);const d={line:this._cssVar("--color-chart-line"),fillStart:this._cssVar("--color-chart-fill-start"),fillEnd:this._cssVar("--color-chart-fill-end"),grid:this._cssVar("--color-chart-grid"),axis:this._cssVar("--color-chart-axis"),dot:this._cssVar("--color-chart-dot"),dotBorder:this._cssVar("--color-chart-dot-border")};if(e.clearRect(0,0,r,o),!this.data||this.data.length<2){e.fillStyle=d.axis,e.font="13px system-ui, sans-serif",e.textAlign="center",e.textBaseline="middle",e.fillText("No data available",r/2,o/2);return}const f=r<380,l={top:14,right:f?8:14,bottom:f?42:46,left:f?50:62},h=r-l.left-l.right,u=o-l.top-l.bottom;if(h<=0||u<=0)return;const _=this.data.map(s=>s.revenue),L=Math.min(..._),F=Math.max(..._),{min:$,max:H,ticks:M}=Q(L,F,5),y=this.data.length,g=s=>l.left+s/(y-1)*h,p=s=>l.top+u-(s-$)/(H-$)*u;e.save(),e.strokeStyle=d.grid,e.lineWidth=1,e.setLineDash([3,4]);for(const s of M){const m=p(s);e.beginPath(),e.moveTo(l.left,m),e.lineTo(l.left+h,m),e.stroke()}e.setLineDash([]),e.restore(),e.save(),e.strokeStyle=d.grid,e.lineWidth=1,e.beginPath(),e.moveTo(l.left,l.top),e.lineTo(l.left,l.top+u),e.stroke(),e.beginPath(),e.moveTo(l.left,l.top+u),e.lineTo(l.left+h,l.top+u),e.stroke(),e.restore();const A=f?9:10;e.save(),e.fillStyle=d.axis,e.font=`${A}px system-ui, -apple-system, sans-serif`,e.textAlign="right",e.textBaseline="middle";for(const s of M){const m=p(s);e.fillText(te(s),l.left-5,m),e.save(),e.strokeStyle=d.axis,e.lineWidth=1,e.beginPath(),e.moveTo(l.left-3,m),e.lineTo(l.left,m),e.stroke(),e.restore()}e.restore();const N=f?8:9,U=f?4:r<500?5:r<700?7:9,V=ee(y,U);e.save(),e.fillStyle=d.axis,e.font=`${N}px system-ui, -apple-system, sans-serif`,e.textAlign="center",e.textBaseline="top";for(const s of V){const m=g(s);e.fillText(ne(this.data[s].date),m,l.top+u+7),e.save(),e.strokeStyle=d.axis,e.lineWidth=1,e.beginPath(),e.moveTo(m,l.top+u),e.lineTo(m,l.top+u+4),e.stroke(),e.restore()}e.restore();const T=e.createLinearGradient(0,l.top,0,l.top+u);T.addColorStop(0,d.fillStart),T.addColorStop(1,d.fillEnd),e.save(),e.beginPath(),e.moveTo(g(0),p(this.data[0].revenue));for(let s=1;s<y;s++)D(e,g(s-1),p(this.data[s-1].revenue),g(s),p(this.data[s].revenue));e.lineTo(g(y-1),l.top+u),e.lineTo(g(0),l.top+u),e.closePath(),e.fillStyle=T,e.fill(),e.restore(),e.save(),e.strokeStyle=d.line,e.lineWidth=2,e.lineJoin="round",e.lineCap="round",e.beginPath(),e.moveTo(g(0),p(this.data[0].revenue));for(let s=1;s<y;s++)D(e,g(s-1),p(this.data[s-1].revenue),g(s),p(this.data[s].revenue));e.stroke(),e.restore();const C=f?2:2.5,j=y<=15||h/y>10;e.save();for(let s=0;s<y;s++){if(!j&&s%5!==0&&s!==0&&s!==y-1)continue;const m=g(s),E=p(this.data[s].revenue);e.beginPath(),e.arc(m,E,C+1.5,0,Math.PI*2),e.fillStyle=d.dotBorder,e.fill(),e.beginPath(),e.arc(m,E,C,0,Math.PI*2),e.fillStyle=d.dot,e.fill()}e.restore(),f||(e.save(),e.fillStyle=d.axis,e.font="9px system-ui, -apple-system, sans-serif",e.textAlign="center",e.textBaseline="middle",e.translate(10,l.top+u/2),e.rotate(-Math.PI/2),e.fillText("Revenue ($)",0,0),e.restore())}}function D(t,n,i,a,r){const o=(n+a)/2;t.bezierCurveTo(o,i,o,r,a,r)}function Q(t,n,i){const a=n-t;if(a===0){const h=Math.abs(t)*.1||1;return{min:t-h,max:n+h,ticks:[t]}}const r=a/(i-1),o=Math.pow(10,Math.floor(Math.log10(r))),c=Math.ceil(r/o)*o,e=Math.floor(t/c)*c,d=Math.ceil(n/c)*c,f=[],l=Math.round((d-e)/c);for(let h=0;h<=l;h++)f.push(e+h*c);return{min:e,max:d,ticks:f}}function ee(t,n){if(n>=t)return Array.from({length:t},(r,o)=>o);const i=new Set([0,t-1]),a=(t-1)/(n-1);for(let r=1;r<n-1;r++)i.add(Math.round(r*a));return[...i].sort((r,o)=>r-o)}function te(t){return Math.abs(t)>=1e6?"$"+(t/1e6).toFixed(1)+"M":Math.abs(t)>=1e3?"$"+(t/1e3).toFixed(0)+"k":"$"+t.toFixed(0)}function ne(t){const n=String(t).split("T")[0].split("-");return new Date(Date.UTC(+n[0],+n[1]-1,+n[2])).toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"})}const I="/api";async function x(t){const n=await fetch(`${I}${t}`);if(!n.ok)throw new Error(`HTTP ${n.status} from ${t}`);return n.json()}async function re(){try{const[t,n,i,a]=await Promise.all([x("/summary"),x("/timeseries"),x("/categories"),x("/recent")]);return{summary:t,timeseries:n,categories:i,recent:a,error:null}}catch(t){return console.error("API fetch failed:",t),{summary:null,timeseries:null,categories:null,recent:null,error:"Unable to connect to the server. Please ensure the backend is running."}}}async function oe(){try{return await x("/settings")}catch(t){return console.error("Failed to fetch settings:",t),{theme:"light"}}}async function ie(t){try{const n=await fetch(`${I}/settings`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(t)});if(!n.ok)throw new Error(`HTTP ${n.status}`);return n.json()}catch(n){return console.error("Failed to update settings:",n),null}}let v="light";async function se(){v=(await oe()).theme||"light",P(v);const n=document.getElementById("theme-toggle");n&&n.addEventListener("click",async()=>{v=v==="light"?"dark":"light",P(v),await ie({theme:v}),window.dispatchEvent(new CustomEvent("themechange",{detail:{theme:v}}))})}function P(t){document.documentElement.setAttribute("data-theme",t)}let k=null;async function ae(){await se();const{summary:t,timeseries:n,categories:i,recent:a,error:r}=await re();if(r){le(r),ce();return}q(t);const o=document.getElementById("timeseries-chart"),c=document.getElementById("chart-container");o&&c&&(k=new Z(o,n),requestAnimationFrame(()=>{k.draw()}),new ResizeObserver(()=>{k&&k.draw()}).observe(c)),X(i),Y(a)}function le(t){const n=document.getElementById("error-banner"),i=document.getElementById("error-message");n&&i&&(i.textContent=t,n.hidden=!1)}function ce(){const t=document.getElementById("stat-cards");t&&(t.innerHTML=`
      <div class="stat-card" style="grid-column: 1 / -1; text-align: center;
           color: var(--color-text-muted); padding: 2rem 1rem;">
        Dashboard data unavailable — backend is offline.
      </div>
    `);const n=document.getElementById("timeseries-chart");if(n){const r=n.getContext("2d");if(r){const o=n.parentElement,c=o?o.clientWidth:300,e=o?o.clientHeight:200;n.width=c,n.height=e,n.style.width=c+"px",n.style.height=e+"px",r.fillStyle=getComputedStyle(document.documentElement).getPropertyValue("--color-text-muted").trim(),r.font="13px system-ui, sans-serif",r.textAlign="center",r.textBaseline="middle",r.fillText("No data — backend offline",c/2,e/2)}}const i=document.getElementById("categories-list");i&&(i.innerHTML=`
      <p style="color: var(--color-text-muted); font-size: 0.875rem; padding: 0.5rem 0;">
        No data available.
      </p>
    `);const a=document.getElementById("recent-tbody");a&&(a.innerHTML=`
      <tr>
        <td colspan="4" style="text-align:center; color: var(--color-text-muted);
            padding: 2rem;">
          No data available.
        </td>
      </tr>
    `)}ae();
