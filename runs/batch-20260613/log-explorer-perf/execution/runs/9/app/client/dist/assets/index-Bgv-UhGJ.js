(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e=`http://localhost:3001`,t=34,n=12,r=120,i=100,a=[``,`debug`,`info`,`warn`,`error`],o={total:0,rows:[],windowStart:0,loading:!1,severity:``,q:``,requestSeq:0,abort:null,stats:null},s=document.querySelector(`#app`);s.innerHTML=`
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100k deterministic logs, server-side filtering, virtualized rendering.</p>
    </div>
    <div class="status" id="status">Starting…</div>
  </header>
  <section class="filters">
    <label>Severity
      <select id="severity">
        <option value="">All severities</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>
    </label>
    <label class="searchLabel">Message contains
      <input id="search" type="search" placeholder="try: rare-unicorn, timeout, cache" autocomplete="off" />
    </label>
    <div class="badges" id="badges"></div>
  </section>
  <main class="panel">
    <div class="tableHead" aria-hidden="true">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log rows">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
      <div id="empty" class="empty" hidden>No logs match the active filters.</div>
    </div>
  </main>
`;var c={status:document.querySelector(`#status`),severity:document.querySelector(`#severity`),search:document.querySelector(`#search`),badges:document.querySelector(`#badges`),scroller:document.querySelector(`#scroller`),spacer:document.querySelector(`#spacer`),rows:document.querySelector(`#rows`),empty:document.querySelector(`#empty`)};function l(e,t){let n;return(...r)=>{clearTimeout(n),n=setTimeout(()=>e(...r),t)}}function u(e,t){let n=new URLSearchParams({offset:String(e),limit:String(t)});return o.severity&&n.set(`severity`,o.severity),o.q&&n.set(`q`,o.q),n}async function d(){let t=await fetch(`${e}/api/stats`);if(!t.ok)throw Error(`failed to load stats`);o.stats=await t.json(),f()}function f(){let e=o.stats;if(!e){c.badges.textContent=``;return}let t=[`<span class="badge all">all ${e.total.toLocaleString()}</span>`];for(let n of a.slice(1))t.push(`<span class="badge sev ${n}">${n} ${(e.perSeverity?.[n]??0).toLocaleString()}</span>`);c.badges.innerHTML=t.join(``)}function p(){let e=c.scroller.scrollTop,r=Math.ceil(c.scroller.clientHeight/t)||1,a=Math.max(0,Math.floor(e/t)-n),s=Math.min(i,r+n*2),l=Math.min(o.total,a+s);return{first:a,last:l,count:Math.max(0,l-a)}}function m(e,t){return e>=o.windowStart&&t<=o.windowStart+o.rows.length}function h(){c.spacer.style.height=`${o.total*t}px`,c.empty.hidden=o.loading||o.total!==0;let{first:e,last:n}=p();!m(e,n)&&!o.loading&&x(e);let r=document.createDocumentFragment(),i=Math.max(e,o.windowStart),a=Math.min(n,o.windowStart+o.rows.length);for(let e=i;e<a;e++){let n=o.rows[e-o.windowStart];if(!n)continue;let i=document.createElement(`div`);i.className=`logRow`,i.dataset.offset=String(e),i.style.transform=`translateY(${e*t}px)`,i.innerHTML=`
      <div class="ts">${v(_(n.ts))}</div>
      <div><span class="pill ${n.severity}">${n.severity}</span></div>
      <div class="service">${v(n.service)}</div>
      <div class="message">${v(n.message)}</div>
    `,r.appendChild(i)}c.rows.replaceChildren(r),c.status.textContent=g(a-i,e)}function g(e,t){if(o.loading&&o.total===0)return`Loading…`;let n=o.total===0?0:t+1,r=Math.min(o.total,t+e),i=[o.severity||`all`,o.q?`“${o.q}”`:``].filter(Boolean).join(` `);return`${n.toLocaleString()}–${r.toLocaleString()} of ${o.total.toLocaleString()} ${i}`}function _(e){let t=new Date(e);return Number.isNaN(t.valueOf())?e:t.toLocaleString()}function v(e){return String(e).replace(/[&<>"]/g,e=>({"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`})[e])}var y=0;function b(){y||=requestAnimationFrame(()=>{y=0,h()})}function x(e){S(Math.max(0,Math.min(e-n,Math.max(0,o.total-r))))}async function S(t=0){let n=++o.requestSeq;o.abort&&o.abort.abort();let i=new AbortController;o.abort=i,o.loading=!0,o.rows.length===0&&h();let a=performance.now();try{let s=await fetch(`${e}/api/logs?${u(t,r)}`,{signal:i.signal});if(!s.ok)throw Error((await s.json()).error||`HTTP ${s.status}`);let l=await s.json();if(n!==o.requestSeq)return;o.total=l.total,o.windowStart=t,o.rows=l.rows,o.loading=!1,h();let d=Math.round(performance.now()-a);c.status.title=`Last request ${d}ms`}catch(e){if(e.name===`AbortError`||n!==o.requestSeq)return;console.error(e),o.loading=!1,c.status.textContent=`Error: ${e.message}`}}function C(){c.scroller.scrollTop=0,o.rows=[],o.windowStart=0,o.total=0,h(),S(0)}c.scroller.addEventListener(`scroll`,b,{passive:!0}),c.severity.addEventListener(`change`,()=>{o.severity=c.severity.value,C()}),c.search.addEventListener(`input`,l(()=>{o.q=c.search.value.trim(),C()},250)),d().catch(e=>console.warn(e)),S(0);