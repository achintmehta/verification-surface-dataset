(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))l(r);new MutationObserver(r=>{for(const n of r)if(n.type==="childList")for(const d of n.addedNodes)d.tagName==="LINK"&&d.rel==="modulepreload"&&l(d)}).observe(document,{childList:!0,subtree:!0});function a(r){const n={};return r.integrity&&(n.integrity=r.integrity),r.referrerPolicy&&(n.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?n.credentials="include":r.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function l(r){if(r.ep)return;r.ep=!0;const n=a(r);fetch(r.href,n)}})();const m="http://localhost:3001",L=document.querySelector("#app");let f={columns:[]},c=[],p=new Set,g=null,u=null,I=null;function o(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function S(e){for(const t of f.columns){const a=t.cards.findIndex(l=>l.id===e);if(a!==-1)return{column:t,index:a,card:t.cards[a]}}return null}function C(e){let t=null;for(const a of f.columns){const l=a.cards.findIndex(r=>r.id===e);if(l!==-1){const[r]=a.cards.splice(l,1);t=r}}return t}function $(e){const t=new Set;return{columns:[...e.columns||[]].map(l=>({...l,cards:[...l.cards||[]].filter(r=>t.has(r.id)?!1:(t.add(r.id),!0)).map(r=>({...r,labels:r.labels||[]})).sort(_)})).sort((l,r)=>Number(l.position)-Number(r.position)||l.id.localeCompare(r.id))}}function _(e,t){return Number(e.position)-Number(t.position)||String(e.created_at).localeCompare(String(t.created_at))||e.id.localeCompare(t.id)}function M(e){if(p.size===0)return!0;const t=new Set((e.labels||[]).map(a=>a.id));for(const a of p)if(t.has(a))return!0;return!1}function b(){L.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-right">
        <button class="btn-manage-labels" id="btn-manage-labels">🏷 Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${j()}
    <main class="board">
      ${f.columns.map(O).join("")}
    </main>
    <div id="label-manager-overlay" class="overlay hidden"></div>
    <dialog id="label-manager" class="label-manager hidden">
      ${E()}
    </dialog>
    <dialog id="card-label-dialog" class="card-label-dialog hidden"></dialog>
  `,J()}function j(){return c.length===0?'<div class="filter-bar filter-bar--empty"></div>':`
    <div class="filter-bar">
      <span class="filter-bar__label">Filter:</span>
      <div class="filter-bar__chips">
        ${c.map(e=>`
          <button
            class="filter-chip${p.has(e.id)?" filter-chip--active":""}"
            data-filter-label-id="${o(e.id)}"
            style="--chip-color: ${o(e.color)}"
          >${o(e.name)}</button>
        `).join("")}
      </div>
      ${p.size>0?'<button class="filter-clear" id="filter-clear">✕ Clear filter</button>':""}
    </div>
  `}function O(e){const t=e.cards.filter(M),a=e.cards.length-t.length;return`
    <section class="column" data-column-id="${o(e.id)}">
      <h2>${o(e.title)}</h2>
      <form class="add-card" data-column-id="${o(e.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${o(e.id)}">
        ${t.map(B).join("")}
        ${a>0?`<div class="hidden-cards-notice">${a} card${a>1?"s":""} hidden by filter</div>`:""}
      </div>
    </section>
  `}function B(e){const t=e.labels||[];return`
    <article class="card" draggable="true" data-card-id="${o(e.id)}" title="Drag to move">
      <div class="card-text">${o(e.text)}</div>
      ${t.length>0?`<div class="card-labels">${t.map(a=>`<span class="label-chip" style="background:${o(a.color)};color:${D(a.color)}">${o(a.name)}</span>`).join("")}</div>`:""}
      <button class="card-label-btn" data-card-id="${o(e.id)}" title="Manage labels">🏷</button>
    </article>
  `}function D(e){const t=parseInt(e.slice(1,3),16),a=parseInt(e.slice(3,5),16),l=parseInt(e.slice(5,7),16);return(.299*t+.587*a+.114*l)/255>.55?"#000000":"#ffffff"}function E(){return`
    <div class="label-manager__header">
      <h2>Label Manager</h2>
      <button class="label-manager__close" id="label-manager-close">✕</button>
    </div>
    <form class="label-create-form" id="label-create-form">
      <input
        type="text"
        name="name"
        placeholder="Label name…"
        maxlength="100"
        autocomplete="off"
        required
      />
      <input type="color" name="color" value="#2563eb" title="Pick a color" />
      <button type="submit">Create</button>
    </form>
    <ul class="label-list" id="label-list">
      ${c.map(T).join("")}
    </ul>
  `}function T(e){return`
    <li class="label-row" data-label-id="${o(e.id)}">
      <span class="label-swatch" style="background:${o(e.color)}"></span>
      <span class="label-row__name">${o(e.name)}</span>
      <button class="label-row__edit" data-label-id="${o(e.id)}" title="Edit">✏️</button>
      <button class="label-row__delete" data-label-id="${o(e.id)}" title="Delete">🗑</button>
    </li>
  `}function k(e){const t=new Set((e.labels||[]).map(a=>a.id));return`
    <div class="label-manager__header">
      <h2>Labels for card</h2>
      <button class="label-manager__close" id="card-label-dialog-close">✕</button>
    </div>
    <p class="card-label-dialog__card-text">${o(e.text)}</p>
    <ul class="label-list">
      ${c.length===0?'<li class="label-list__empty">No labels yet. Create some in the Label Manager.</li>':c.map(a=>`
          <li class="label-row label-row--toggle" data-label-id="${o(a.id)}" data-card-id="${o(e.id)}">
            <span class="label-swatch" style="background:${o(a.color)}"></span>
            <span class="label-row__name">${o(a.name)}</span>
            <input
              type="checkbox"
              class="label-assign-checkbox"
              data-card-id="${o(e.id)}"
              data-label-id="${o(a.id)}"
              ${t.has(a.id)?"checked":""}
            />
          </li>
        `).join("")}
    </ul>
  `}function N(){const e=document.getElementById("label-manager"),t=document.getElementById("label-manager-overlay");e.innerHTML=E(),e.classList.remove("hidden"),t.classList.remove("hidden"),w(e)}function x(){const e=document.getElementById("label-manager"),t=document.getElementById("label-manager-overlay");e.classList.add("hidden"),t.classList.add("hidden")}function w(e){e.querySelector("#label-manager-close").addEventListener("click",x),e.querySelector("#label-create-form").addEventListener("submit",async t=>{t.preventDefault();const a=t.target,l=a.elements.name.value.trim(),r=a.elements.color.value;if(l)try{const n=await fetch(`${m}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:l,color:r})});if(!n.ok){const d=await n.json();i(`Create label failed: ${d.error}`,!0);return}a.elements.name.value=""}catch(n){i(`Create label failed: ${n.message}`,!0)}}),e.querySelectorAll(".label-row__delete").forEach(t=>{t.addEventListener("click",async()=>{const a=t.dataset.labelId;if(confirm("Delete this label? It will be removed from all cards."))try{const l=await fetch(`${m}/api/labels/${a}`,{method:"DELETE"});if(!l.ok&&l.status!==204){const r=await l.json();i(`Delete label failed: ${r.error}`,!0)}}catch(l){i(`Delete label failed: ${l.message}`,!0)}})}),e.querySelectorAll(".label-row__edit").forEach(t=>{t.addEventListener("click",()=>{const a=t.dataset.labelId,l=c.find(r=>r.id===a);l&&P(e,a,l)})})}function P(e,t,a){const l=e.querySelector(`.label-row[data-label-id="${t}"]`);l&&(l.innerHTML=`
    <input type="text" class="label-edit-name" value="${o(a.name)}" maxlength="100" />
    <input type="color" class="label-edit-color" value="${o(a.color)}" />
    <button class="label-edit-save" data-label-id="${o(t)}">Save</button>
    <button class="label-edit-cancel">Cancel</button>
  `,l.querySelector(".label-edit-cancel").addEventListener("click",()=>{l.outerHTML=T(a),w(e)}),l.querySelector(".label-edit-save").addEventListener("click",async()=>{const r=l.querySelector(".label-edit-name").value.trim(),n=l.querySelector(".label-edit-color").value;if(!r){i("Label name cannot be empty",!0);return}try{const d=await fetch(`${m}/api/labels/${t}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:r,color:n})});if(!d.ok){const s=await d.json();i(`Update label failed: ${s.error}`,!0);return}}catch(d){i(`Update label failed: ${d.message}`,!0)}}))}function H(e){const t=S(e);if(!t)return;const a=document.getElementById("card-label-dialog"),l=document.getElementById("label-manager-overlay");a.innerHTML=k(t.card),a.classList.remove("hidden"),l.classList.remove("hidden"),A(a)}function q(){const e=document.getElementById("card-label-dialog"),t=document.getElementById("label-manager-overlay");e.classList.add("hidden"),t.classList.add("hidden")}function A(e,t){e.querySelector("#card-label-dialog-close").addEventListener("click",q),e.querySelectorAll(".label-assign-checkbox").forEach(a=>{a.addEventListener("change",async()=>{const{cardId:l,labelId:r}=a.dataset,n=a.checked;try{if(n){const d=await fetch(`${m}/api/cards/${l}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:r})});if(!d.ok){const s=await d.json();i(`Assign label failed: ${s.error}`,!0),a.checked=!n}}else{const d=await fetch(`${m}/api/cards/${l}/labels/${r}`,{method:"DELETE"});if(!d.ok){const s=await d.json();i(`Unassign label failed: ${s.error}`,!0),a.checked=!n}}}catch(d){i(`Label assignment failed: ${d.message}`,!0),a.checked=!n}})})}function J(){var e,t,a;(e=document.getElementById("btn-manage-labels"))==null||e.addEventListener("click",N),(t=document.getElementById("label-manager-overlay"))==null||t.addEventListener("click",()=>{x(),q()}),document.querySelectorAll(".filter-chip").forEach(l=>{l.addEventListener("click",()=>{const r=l.dataset.filterLabelId;p.has(r)?p.delete(r):p.add(r),b()})}),(a=document.getElementById("filter-clear"))==null||a.addEventListener("click",()=>{p.clear(),b()}),document.querySelectorAll(".add-card").forEach(l=>{l.addEventListener("submit",async r=>{r.preventDefault();const n=l.elements.text,d=n.value.trim();d&&(n.value="",await U(l.dataset.columnId,d))})}),document.querySelectorAll(".card-label-btn").forEach(l=>{l.addEventListener("click",r=>{r.stopPropagation(),H(l.dataset.cardId)})}),document.querySelectorAll(".card").forEach(l=>{l.addEventListener("dragstart",r=>{g=l.dataset.cardId,l.classList.add("dragging"),r.dataTransfer.effectAllowed="move"}),l.addEventListener("dragend",()=>{g=null,l.classList.remove("dragging")})}),document.querySelectorAll(".cards").forEach(l=>{l.addEventListener("dragover",r=>{r.preventDefault(),r.dataTransfer.dropEffect="move",l.classList.add("drop-target")}),l.addEventListener("dragleave",r=>{l.contains(r.relatedTarget)||l.classList.remove("drop-target")}),l.addEventListener("drop",async r=>{if(r.preventDefault(),l.classList.remove("drop-target"),!g)return;const n=l.dataset.columnId,{afterId:d,beforeId:s}=F(l,g);R(g,n,s,d),b(),await z(g,n,s,d)})})}function F(e,t){const a=[...e.querySelectorAll(".card")].map(r=>r.dataset.cardId),l=a.indexOf(t);return{afterId:l>0?a[l-1]:null,beforeId:l>=0&&l<a.length-1?a[l+1]:null}}function R(e,t,a,l){const r=C(e);if(!r)return;const n=f.columns.find(h=>h.id===t);if(!n)return;const d=l?n.cards.findIndex(h=>h.id===l):-1,s=a?n.cards.findIndex(h=>h.id===a):-1;let v=n.cards.length;d!==-1?v=d+1:s!==-1&&(v=s),n.cards.splice(v,0,{...r,column_id:t,optimistic:!0})}async function U(e,t){try{const a=await fetch(`${m}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:e,text:t})});if(!a.ok)throw new Error((await a.json()).error||"Create failed")}catch(a){i(`Create failed: ${a.message}`,!0)}}async function z(e,t,a,l){try{const r=await fetch(`${m}/api/cards/${e}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:t,beforeId:a,afterId:l})});if(!r.ok)throw new Error((await r.json()).error||"Move failed")}catch(r){i(`Move failed: ${r.message}`,!0)}}function K(e){if(e.board){f=$(e.board),b(),i("Synced");return}if(!e.card)return;const t=e.card;C(t.id);const a=f.columns.find(l=>l.id===t.column_id||l.id===e.columnId);a&&(a.cards.push(t),a.cards.sort(_),b(),i("Synced"))}function G(e){switch(e.type){case"label-created":{c.find(t=>t.id===e.label.id)||(c.push(e.label),c.sort((t,a)=>t.name.localeCompare(a.name))),y(),b();break}case"label-updated":{const t=c.findIndex(a=>a.id===e.label.id);t!==-1?c[t]=e.label:c.push(e.label),c.sort((a,l)=>a.name.localeCompare(l.name));for(const a of f.columns)for(const l of a.cards)l.labels=(l.labels||[]).map(r=>r.id===e.label.id?e.label:r);y(),b();break}case"label-deleted":{c=c.filter(t=>t.id!==e.labelId),p.delete(e.labelId);for(const t of f.columns)for(const a of t.cards)a.labels=(a.labels||[]).filter(l=>l.id!==e.labelId);y(),b();break}case"card-label-assigned":case"card-label-unassigned":{if(e.board)f=$(e.board);else if(e.card)for(const t of f.columns){const a=t.cards.findIndex(l=>l.id===e.cardId);a!==-1&&(t.cards[a]={...e.card,labels:e.card.labels||[]})}Q(e.cardId),b(),i("Synced");break}}}function y(){const e=document.getElementById("label-manager");!e||e.classList.contains("hidden")||(e.innerHTML=E(),w(e))}function Q(e){const t=document.getElementById("card-label-dialog");if(!t||t.classList.contains("hidden")||!t.querySelector("#card-label-dialog-close"))return;const l=S(e);l&&(t.innerHTML=k(l.card),A(t))}async function V(){const[e,t]=await Promise.all([fetch(`${m}/api/board`),fetch(`${m}/api/labels`)]);if(!e.ok)throw new Error("Could not load board");if(!t.ok)throw new Error("Could not load labels");f=$(await e.json()),c=await t.json()}function W(){u==null||u.close(),u=new EventSource(`${m}/api/stream`),u.addEventListener("connected",()=>i("Live")),u.addEventListener("mutation",e=>{K(JSON.parse(e.data))}),u.addEventListener("label",e=>{G(JSON.parse(e.data))}),u.onerror=()=>i("Reconnecting…",!0)}function i(e,t=!1){const a=document.querySelector("#status");a&&(a.textContent=e,a.classList.toggle("warn",t)),clearTimeout(I),t&&(I=setTimeout(()=>i((u==null?void 0:u.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function X(){L.innerHTML='<div class="loading">Loading board…</div>';try{await V(),b(),W()}catch(e){L.innerHTML=`<div class="loading error">${o(e.message)}</div>`}}X();
