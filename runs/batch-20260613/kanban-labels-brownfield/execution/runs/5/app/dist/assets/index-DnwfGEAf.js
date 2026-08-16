(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const t of document.querySelectorAll('link[rel="modulepreload"]'))r(t);new MutationObserver(t=>{for(const l of t)if(l.type==="childList")for(const o of l.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&r(o)}).observe(document,{childList:!0,subtree:!0});function n(t){const l={};return t.integrity&&(l.integrity=t.integrity),t.referrerPolicy&&(l.referrerPolicy=t.referrerPolicy),t.crossOrigin==="use-credentials"?l.credentials="include":t.crossOrigin==="anonymous"?l.credentials="omit":l.credentials="same-origin",l}function r(t){if(t.ep)return;t.ep=!0;const l=n(t);fetch(t.href,l)}})();const h="http://localhost:3001",I=document.querySelector("#app");let p={columns:[]},s=[],y=new Set,v=null,u=null,S=null;function d(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function T(e){for(const a of p.columns){const n=a.cards.findIndex(r=>r.id===e);if(n!==-1)return{column:a,index:n,card:a.cards[n]}}return null}function x(e){let a=null;for(const n of p.columns){const r=n.cards.findIndex(t=>t.id===e);if(r!==-1){const[t]=n.cards.splice(r,1);a=t}}return a}function B(e){const a=new Set;return{columns:[...e.columns||[]].map(r=>({...r,cards:[...r.cards||[]].filter(t=>a.has(t.id)?!1:(a.add(t.id),!0)).map(t=>({...t,labels:t.labels||[]})).sort(k)})).sort((r,t)=>Number(r.position)-Number(t.position)||r.id.localeCompare(t.id))}}function k(e,a){return Number(e.position)-Number(a.position)||String(e.created_at).localeCompare(String(a.created_at))||e.id.localeCompare(a.id)}function j(e){if(y.size===0)return!0;const a=new Set((e.labels||[]).map(n=>n.id));for(const n of y)if(a.has(n))return!0;return!1}function b(){I.innerHTML=`
    <header class="topbar">
      <div class="topbar-title">
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button class="btn-manage-labels" id="btn-manage-labels">🏷 Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${P()}
    <main class="board">
      ${p.columns.map(O).join("")}
    </main>
    <div id="label-manager-overlay" class="overlay hidden"></div>
    <div id="label-manager" class="label-manager hidden"></div>
    <div id="card-label-overlay" class="overlay hidden"></div>
    <div id="card-label-panel" class="card-label-panel hidden"></div>
  `,U()}function P(){return s.length===0?"":`
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${s.map(e=>`
        <button
          class="filter-chip${y.has(e.id)?" active":""}"
          data-filter-id="${d(e.id)}"
          style="--chip-color: ${d(e.color)}"
        >${d(e.name)}</button>
      `).join("")}
      ${y.size>0?'<button class="filter-clear" id="filter-clear">✕ Clear</button>':""}
    </div>
  `}function O(e){const a=e.cards.filter(j),n=e.cards.length-a.length;return`
    <section class="column" data-column-id="${d(e.id)}">
      <h2>${d(e.title)}</h2>
      <form class="add-card" data-column-id="${d(e.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${d(e.id)}">
        ${a.map(M).join("")}
        ${n>0?`<div class="hidden-cards-note">${n} card${n>1?"s":""} hidden by filter</div>`:""}
      </div>
    </section>
  `}function M(e){const a=(e.labels||[]).length>0?`<div class="card-labels">${(e.labels||[]).map(n=>`<span class="label-chip" style="background:${d(n.color)}" title="${d(n.name)}">${d(n.name)}</span>`).join("")}</div>`:"";return`
    <article class="card" draggable="true" data-card-id="${d(e.id)}" title="Drag to move">
      <div class="card-text">${d(e.text)}</div>
      ${a}
      <button class="card-label-btn" data-card-id="${d(e.id)}" title="Manage labels">🏷</button>
    </article>
  `}function N(){const e=document.getElementById("label-manager-overlay"),a=document.getElementById("label-manager");e.classList.remove("hidden"),a.classList.remove("hidden"),$()}function A(){document.getElementById("label-manager-overlay").classList.add("hidden"),document.getElementById("label-manager").classList.add("hidden")}function $(){const e=document.getElementById("label-manager");e.innerHTML=`
    <div class="modal-header">
      <h2>Label Manager</h2>
      <button class="modal-close" id="lm-close">✕</button>
    </div>
    <div class="modal-body">
      <form class="label-create-form" id="label-create-form">
        <input name="name" type="text" maxlength="50" placeholder="Label name…" autocomplete="off" required />
        <input name="color" type="color" value="#3b82f6" title="Pick a color" />
        <button type="submit">Create</button>
      </form>
      <div id="lm-error" class="lm-error hidden"></div>
      <ul class="label-list" id="label-list">
        ${s.map(q).join("")}
      </ul>
    </div>
  `,document.getElementById("lm-close").addEventListener("click",A),document.getElementById("label-create-form").addEventListener("submit",D),document.querySelectorAll(".label-edit-form").forEach(F),document.querySelectorAll(".label-delete-btn").forEach(a=>{a.addEventListener("click",()=>H(a.dataset.labelId))})}function q(e){return`
    <li class="label-row" data-label-id="${d(e.id)}">
      <form class="label-edit-form" data-label-id="${d(e.id)}">
        <span class="label-color-swatch" style="background:${d(e.color)}"></span>
        <input name="name" type="text" maxlength="50" value="${d(e.name)}" required />
        <input name="color" type="color" value="${d(e.color)}" title="Pick a color" />
        <button type="submit" class="btn-save">Save</button>
      </form>
      <button class="label-delete-btn" data-label-id="${d(e.id)}" title="Delete label">🗑</button>
    </li>
  `}function E(e){const a=document.getElementById("lm-error");a&&(a.textContent=e,a.classList.remove("hidden"),setTimeout(()=>a.classList.add("hidden"),3e3))}async function D(e){e.preventDefault();const a=e.target,n=a.elements.name.value.trim(),r=a.elements.color.value;if(n)try{const t=await fetch(`${h}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:n,color:r})});if(!t.ok){const l=await t.json();E(l.error||"Failed to create label");return}a.elements.name.value=""}catch(t){E(t.message)}}function F(e){e.addEventListener("submit",async a=>{a.preventDefault();const n=e.dataset.labelId,r=e.elements.name.value.trim(),t=e.elements.color.value;if(r)try{const l=await fetch(`${h}/api/labels/${n}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:r,color:t})});if(!l.ok){const o=await l.json();E(o.error||"Failed to update label")}}catch(l){E(l.message)}})}async function H(e){if(confirm("Delete this label? It will be removed from all cards."))try{const a=await fetch(`${h}/api/labels/${e}`,{method:"DELETE"});if(!a.ok&&a.status!==404){const n=await a.json().catch(()=>({}));E(n.error||"Failed to delete label")}}catch(a){E(a.message)}}let i=null;function J(e){i=e;const a=document.getElementById("card-label-overlay"),n=document.getElementById("card-label-panel");a.classList.remove("hidden"),n.classList.remove("hidden"),L(e)}function w(){i=null,document.getElementById("card-label-overlay").classList.add("hidden"),document.getElementById("card-label-panel").classList.add("hidden")}function L(e){const a=T(e);if(!a){w();return}const n=a.card,r=new Set((n.labels||[]).map(l=>l.id)),t=document.getElementById("card-label-panel");t.innerHTML=`
    <div class="modal-header">
      <h2>Card Labels</h2>
      <button class="modal-close" id="clp-close">✕</button>
    </div>
    <div class="modal-body">
      <p class="clp-card-text">${d(n.text)}</p>
      ${s.length===0?'<p class="clp-empty">No labels yet. Create some in the Label Manager.</p>':`<ul class="clp-label-list">
          ${s.map(l=>`
            <li class="clp-label-row">
              <label class="clp-label-item">
                <input type="checkbox" class="clp-checkbox" data-label-id="${d(l.id)}" ${r.has(l.id)?"checked":""} />
                <span class="label-chip" style="background:${d(l.color)}">${d(l.name)}</span>
              </label>
            </li>
          `).join("")}
        </ul>`}
    </div>
  `,document.getElementById("clp-close").addEventListener("click",w),t.querySelectorAll(".clp-checkbox").forEach(l=>{l.addEventListener("change",async()=>{const o=l.dataset.labelId;l.checked?await _(e,o):await R(e,o)})})}async function _(e,a){try{const n=await fetch(`${h}/api/cards/${e}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:a})});if(!n.ok){const r=await n.json().catch(()=>({}));m(`Assign failed: ${r.error||"unknown"}`,!0)}}catch(n){m(`Assign failed: ${n.message}`,!0)}}async function R(e,a){try{const n=await fetch(`${h}/api/cards/${e}/labels/${a}`,{method:"DELETE"});if(!n.ok){const r=await n.json().catch(()=>({}));m(`Unassign failed: ${r.error||"unknown"}`,!0)}}catch(n){m(`Unassign failed: ${n.message}`,!0)}}function U(){var e,a,n,r;(e=document.getElementById("btn-manage-labels"))==null||e.addEventListener("click",N),(a=document.getElementById("label-manager-overlay"))==null||a.addEventListener("click",A),(n=document.getElementById("card-label-overlay"))==null||n.addEventListener("click",w),document.querySelectorAll(".filter-chip").forEach(t=>{t.addEventListener("click",()=>{const l=t.dataset.filterId;y.has(l)?y.delete(l):y.add(l),b()})}),(r=document.getElementById("filter-clear"))==null||r.addEventListener("click",()=>{y.clear(),b()}),document.querySelectorAll(".card-label-btn").forEach(t=>{t.addEventListener("click",l=>{l.stopPropagation(),J(t.dataset.cardId)})}),document.querySelectorAll(".add-card").forEach(t=>{t.addEventListener("submit",async l=>{l.preventDefault();const o=t.elements.text,c=o.value.trim();c&&(o.value="",await G(t.dataset.columnId,c))})}),document.querySelectorAll(".card").forEach(t=>{t.addEventListener("dragstart",l=>{v=t.dataset.cardId,t.classList.add("dragging"),l.dataTransfer.effectAllowed="move"}),t.addEventListener("dragend",()=>{t.classList.remove("dragging"),v=null})}),document.querySelectorAll(".cards").forEach(t=>{t.addEventListener("dragover",l=>{l.preventDefault(),l.dataTransfer.dropEffect="move",t.classList.add("drop-target")}),t.addEventListener("dragleave",l=>{t.contains(l.relatedTarget)||t.classList.remove("drop-target")}),t.addEventListener("drop",async l=>{if(l.preventDefault(),t.classList.remove("drop-target"),!v)return;const o=t.dataset.columnId,{afterId:c,beforeId:g}=K(t,v,l.clientY);Y(v,o,g,c),b(),await Q(v,o,g,c)})})}function K(e,a,n){const r=[...e.querySelectorAll(".card")].filter(f=>f.dataset.cardId!==a);let t=null;for(const f of r){const C=f.getBoundingClientRect();n>C.top+C.height/2&&(t=f)}const l=t?t.dataset.cardId:null,o=t?r.indexOf(t):-1,c=o<r.length-1?r[o+1]:null,g=c?c.dataset.cardId:null;return{afterId:l,beforeId:g}}function Y(e,a,n,r){const t=x(e);if(!t)return;const l=p.columns.find(f=>f.id===a);if(!l)return;const o=r?l.cards.findIndex(f=>f.id===r):-1,c=n?l.cards.findIndex(f=>f.id===n):-1;let g=l.cards.length;o!==-1?g=o+1:c!==-1&&(g=c),l.cards.splice(g,0,{...t,column_id:a,optimistic:!0})}async function G(e,a){try{const n=await fetch(`${h}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:e,text:a})});if(!n.ok)throw new Error((await n.json()).error||"Create failed")}catch(n){m(`Create failed: ${n.message}`,!0)}}async function Q(e,a,n,r){try{const t=await fetch(`${h}/api/cards/${e}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:a,beforeId:n,afterId:r})});if(!t.ok)throw new Error((await t.json()).error||"Move failed")}catch(t){m(`Move failed: ${t.message}`,!0)}}function V(e){if(e.board){p=B(e.board),b(),i&&L(i),m("Synced");return}if(!e.card)return;const a=e.card;x(a.id);const n=p.columns.find(r=>r.id===a.column_id||r.id===e.columnId);n&&(n.cards.push({...a,labels:a.labels||[]}),n.cards.sort(k),b(),i&&L(i),m("Synced"))}function W(e){const{type:a}=e;if(a==="label-created"){s.find(n=>n.id===e.label.id)||(s.push(e.label),s.sort((n,r)=>n.name.localeCompare(r.name))),b(),document.getElementById("label-manager")&&!document.getElementById("label-manager").classList.contains("hidden")&&$();return}if(a==="label-updated"){const n=s.findIndex(r=>r.id===e.label.id);n!==-1?s[n]=e.label:s.push(e.label),s.sort((r,t)=>r.name.localeCompare(t.name));for(const r of p.columns)for(const t of r.cards)t.labels=(t.labels||[]).map(l=>l.id===e.label.id?e.label:l);b(),document.getElementById("label-manager")&&!document.getElementById("label-manager").classList.contains("hidden")&&$(),i&&L(i);return}if(a==="label-deleted"){s=s.filter(n=>n.id!==e.labelId),y.delete(e.labelId);for(const n of p.columns)for(const r of n.cards)r.labels=(r.labels||[]).filter(t=>t.id!==e.labelId);b(),document.getElementById("label-manager")&&!document.getElementById("label-manager").classList.contains("hidden")&&$(),i&&L(i);return}if(a==="card-label-assigned"||a==="card-label-unassigned"){if(e.card){const n=e.card;for(const r of p.columns){const t=r.cards.findIndex(l=>l.id===n.id);t!==-1&&(r.cards[t]={...r.cards[t],labels:n.labels||[]})}}b(),i&&L(i);return}}async function X(){const e=await fetch(`${h}/api/board`);if(!e.ok)throw new Error("Could not load board");p=B(await e.json())}async function Z(){const e=await fetch(`${h}/api/labels`);if(!e.ok)throw new Error("Could not load labels");s=await e.json()}function z(){u==null||u.close(),u=new EventSource(`${h}/api/stream`),u.addEventListener("connected",()=>m("Live")),u.addEventListener("mutation",e=>{V(JSON.parse(e.data))}),u.addEventListener("label",e=>{W(JSON.parse(e.data))}),u.onerror=()=>m("Reconnecting…",!0)}function m(e,a=!1){const n=document.querySelector("#status");n&&(n.textContent=e,n.classList.toggle("warn",a)),clearTimeout(S),a&&(S=setTimeout(()=>m((u==null?void 0:u.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function ee(){I.innerHTML='<div class="loading">Loading board…</div>';try{await Promise.all([X(),Z()]),b(),z()}catch(e){I.innerHTML=`<div class="loading error">${d(e.message)}</div>`}}ee();
