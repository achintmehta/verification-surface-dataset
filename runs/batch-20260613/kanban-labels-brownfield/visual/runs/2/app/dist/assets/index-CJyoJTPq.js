(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))l(n);new MutationObserver(n=>{for(const r of n)if(r.type==="childList")for(const o of r.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&l(o)}).observe(document,{childList:!0,subtree:!0});function e(n){const r={};return n.integrity&&(r.integrity=n.integrity),n.referrerPolicy&&(r.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?r.credentials="include":n.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function l(n){if(n.ep)return;n.ep=!0;const r=e(n);fetch(n.href,r)}})();const f="http://localhost:3001",g=document.querySelector("#app");let m={columns:[]},i=[],p=new Set,h=null,u=null,$=null;function d(t){return String(t).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function I(t){for(const a of m.columns){const e=a.cards.findIndex(l=>l.id===t);if(e!==-1)return{column:a,index:e,card:a.cards[e]}}return null}function E(t){let a=null;for(const e of m.columns){const l=e.cards.findIndex(n=>n.id===t);if(l!==-1){const[n]=e.cards.splice(l,1);a=n}}return a}function w(t){const a=new Set;return{columns:[...t.columns||[]].map(l=>({...l,cards:[...l.cards||[]].filter(n=>a.has(n.id)?!1:(a.add(n.id),!0)).map(n=>({...n,labels:n.labels||[]})).sort(L)})).sort((l,n)=>Number(l.position)-Number(n.position)||l.id.localeCompare(n.id))}}function L(t,a){return Number(t.position)-Number(a.position)||String(t.created_at).localeCompare(String(a.created_at))||t.id.localeCompare(a.id)}function C(t){if(p.size===0)return!0;const a=new Set((t.labels||[]).map(e=>e.id));for(const e of p)if(a.has(e))return!0;return!1}function y(){g.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    ${S()}
    <main class="board">
      ${m.columns.map(x).join("")}
    </main>
    ${A()}
  `,j()}function S(){if(i.length===0)return"";const t=i.map(e=>`<button
      class="filter-chip${p.has(e.id)?" active":""}"
      data-filter-label-id="${d(e.id)}"
      style="--chip-color:${d(e.color)}"
      title="Filter by ${d(e.name)}"
    >${d(e.name)}</button>`).join(""),a=p.size>0?'<button class="filter-clear" id="filter-clear">Clear filter</button>':"";return`
    <div class="filter-bar">
      <span class="filter-label-text">Filter:</span>
      ${t}
      ${a}
      <button class="manage-labels-btn" id="open-label-manager">⚙ Labels</button>
    </div>
  `}function x(t){const a=t.cards.filter(C),e=t.cards.length-a.length,l=e>0?`<p class="hidden-note">${e} card${e>1?"s":""} hidden by filter</p>`:"";return`
    <section class="column" data-column-id="${d(t.id)}">
      <h2>${d(t.title)}</h2>
      <form class="add-card" data-column-id="${d(t.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      ${l}
      <div class="cards" data-column-id="${d(t.id)}">
        ${a.map(k).join("")}
      </div>
    </section>
  `}function k(t){const e=`<div class="card-labels">${(t.labels||[]).map(l=>`<span class="label-chip" style="background:${d(l.color)}" title="${d(l.name)}">${d(l.name)}</span>`).join("")}</div>`;return`
    <article class="card" draggable="true" data-card-id="${d(t.id)}" title="Drag to move">
      <div class="card-text">${d(t.text)}</div>
      ${e}
      <button class="card-label-btn" data-card-id="${d(t.id)}" title="Manage labels">🏷</button>
    </article>
  `}function A(){return`
    <div class="label-manager-overlay" id="label-manager-overlay" style="display:none">
      <div class="label-manager" id="label-manager">
        <div class="label-manager-header">
          <h2>Labels</h2>
          <button class="label-manager-close" id="close-label-manager">✕</button>
        </div>
        <ul class="label-list" id="label-list">
          ${i.map(B).join("")}
        </ul>
        <form class="label-create-form" id="label-create-form">
          <input name="name" type="text" maxlength="50" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" value="#3b82f6" title="Pick a color" />
          <button type="submit">Add</button>
        </form>
      </div>
    </div>
  `}function B(t){return`
    <li class="label-row" data-label-id="${d(t.id)}">
      <span class="label-swatch" style="background:${d(t.color)}"></span>
      <span class="label-name">${d(t.name)}</span>
      <button class="label-edit-btn" data-label-id="${d(t.id)}" title="Edit">✏</button>
      <button class="label-delete-btn" data-label-id="${d(t.id)}" title="Delete">🗑</button>
    </li>
  `}function T(t){const a=new Set((t.labels||[]).map(l=>l.id)),e=i.map(l=>{const n=a.has(l.id);return`
      <li class="card-label-row">
        <label>
          <input type="checkbox" class="card-label-checkbox"
            data-card-id="${d(t.id)}"
            data-label-id="${d(l.id)}"
            ${n?"checked":""} />
          <span class="label-swatch" style="background:${d(l.color)}"></span>
          ${d(l.name)}
        </label>
      </li>
    `}).join("");return`
    <div class="modal-overlay" id="card-label-modal-overlay">
      <div class="modal" id="card-label-modal">
        <div class="modal-header">
          <h3>Labels for card</h3>
          <button class="modal-close" id="close-card-label-modal">✕</button>
        </div>
        ${i.length===0?'<p class="modal-empty">No labels yet. Create some in ⚙ Labels.</p>':""}
        <ul class="card-label-list">${e}</ul>
      </div>
    </div>
  `}function j(){document.querySelectorAll(".add-card").forEach(r=>{r.addEventListener("submit",async o=>{o.preventDefault();const s=r.elements.text,b=s.value.trim();b&&(s.value="",await P(r.dataset.columnId,b))})}),document.querySelectorAll(".card").forEach(r=>{r.addEventListener("dragstart",o=>{h=r.dataset.cardId,r.classList.add("dragging"),o.dataTransfer.effectAllowed="move"}),r.addEventListener("dragend",()=>{r.classList.remove("dragging"),h=null})}),document.querySelectorAll(".cards").forEach(r=>{r.addEventListener("dragover",o=>{o.preventDefault(),o.dataTransfer.dropEffect="move",r.classList.add("drop-target")}),r.addEventListener("dragleave",()=>r.classList.remove("drop-target")),r.addEventListener("drop",async o=>{if(o.preventDefault(),r.classList.remove("drop-target"),!h)return;const s=r.dataset.columnId,{afterId:b,beforeId:v}=N(r,h);q(h,s,v,b),y(),await D(h,s,v,b)})}),document.querySelectorAll(".filter-chip").forEach(r=>{r.addEventListener("click",()=>{const o=r.dataset.filterLabelId;p.has(o)?p.delete(o):p.add(o),y()})});const t=document.getElementById("filter-clear");t&&t.addEventListener("click",()=>{p.clear(),y()});const a=document.getElementById("open-label-manager");a&&a.addEventListener("click",()=>{document.getElementById("label-manager-overlay").style.display="flex"});const e=document.getElementById("close-label-manager");e&&e.addEventListener("click",()=>{document.getElementById("label-manager-overlay").style.display="none"});const l=document.getElementById("label-manager-overlay");l&&l.addEventListener("click",r=>{r.target===l&&(l.style.display="none")});const n=document.getElementById("label-create-form");n&&n.addEventListener("submit",async r=>{r.preventDefault();const o=n.elements.name.value.trim(),s=n.elements.color.value;o&&(await F(o,s),n.elements.name.value="")}),document.querySelectorAll(".label-edit-btn").forEach(r=>{r.addEventListener("click",()=>M(r.dataset.labelId))}),document.querySelectorAll(".label-delete-btn").forEach(r=>{r.addEventListener("click",async()=>{const o=i.find(s=>s.id===r.dataset.labelId);o&&confirm(`Delete label "${o.name}"? It will be removed from all cards.`)&&await J(r.dataset.labelId)})}),document.querySelectorAll(".card-label-btn").forEach(r=>{r.addEventListener("click",o=>{o.stopPropagation(),O(r.dataset.cardId)})})}function M(t){var l;const a=i.find(n=>n.id===t);if(!a)return;(l=document.getElementById("edit-label-modal-overlay"))==null||l.remove();const e=document.createElement("div");e.className="modal-overlay",e.id="edit-label-modal-overlay",e.innerHTML=`
    <div class="modal" id="edit-label-modal">
      <div class="modal-header">
        <h3>Edit Label</h3>
        <button class="modal-close" id="close-edit-label-modal">✕</button>
      </div>
      <form id="edit-label-form">
        <div class="edit-label-fields">
          <input id="edit-label-name" type="text" maxlength="50" value="${d(a.name)}" required />
          <input id="edit-label-color" type="color" value="${d(a.color)}" />
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  `,document.body.appendChild(e),e.addEventListener("click",n=>{n.target===e&&e.remove()}),document.getElementById("close-edit-label-modal").addEventListener("click",()=>e.remove()),document.getElementById("edit-label-form").addEventListener("submit",async n=>{n.preventDefault();const r=document.getElementById("edit-label-name").value.trim(),o=document.getElementById("edit-label-color").value;r&&(await H(t,r,o),e.remove())})}function O(t){var n;const a=I(t);if(!a)return;(n=document.getElementById("card-label-modal-overlay"))==null||n.remove();const e=document.createElement("div");e.innerHTML=T(a.card);const l=e.firstElementChild;document.body.appendChild(l),l.addEventListener("click",r=>{r.target===l&&l.remove()}),document.getElementById("close-card-label-modal").addEventListener("click",()=>l.remove()),l.querySelectorAll(".card-label-checkbox").forEach(r=>{r.addEventListener("change",async()=>{const o=r.dataset.cardId,s=r.dataset.labelId;r.checked?await _(o,s):await R(o,s)})})}function N(t,a){const e=[...t.querySelectorAll(".card")].map(n=>n.dataset.cardId),l=e.indexOf(a);return{afterId:l>0?e[l-1]:null,beforeId:l>=0&&l<e.length-1?e[l+1]:null}}function q(t,a,e,l){const n=E(t);if(!n)return;const r=m.columns.find(v=>v.id===a);if(!r)return;const o=l?r.cards.findIndex(v=>v.id===l):-1,s=e?r.cards.findIndex(v=>v.id===e):-1;let b=r.cards.length;o!==-1?b=o+1:s!==-1&&(b=s),r.cards.splice(b,0,{...n,column_id:a,optimistic:!0})}async function P(t,a){try{const e=await fetch(`${f}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:t,text:a})});if(!e.ok)throw new Error((await e.json()).error||"Create failed")}catch(e){c(`Create failed: ${e.message}`,!0)}}async function D(t,a,e,l){try{const n=await fetch(`${f}/api/cards/${t}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:a,beforeId:e,afterId:l})});if(!n.ok)throw new Error((await n.json()).error||"Move failed")}catch(n){c(`Move failed: ${n.message}`,!0)}}async function F(t,a){try{const e=await fetch(`${f}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:t,color:a})});if(!e.ok){const l=await e.json();alert(l.error||"Failed to create label")}}catch(e){c(`Label create failed: ${e.message}`,!0)}}async function H(t,a,e){try{const l=await fetch(`${f}/api/labels/${t}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:a,color:e})});if(!l.ok){const n=await l.json();alert(n.error||"Failed to update label")}}catch(l){c(`Label update failed: ${l.message}`,!0)}}async function J(t){try{const a=await fetch(`${f}/api/labels/${t}`,{method:"DELETE"});if(!a.ok){const e=await a.json();alert(e.error||"Failed to delete label")}}catch(a){c(`Label delete failed: ${a.message}`,!0)}}async function _(t,a){try{const e=await fetch(`${f}/api/cards/${t}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:a})});if(!e.ok){const l=await e.json();alert(l.error||"Failed to assign label")}}catch(e){c(`Label assign failed: ${e.message}`,!0)}}async function R(t,a){try{const e=await fetch(`${f}/api/cards/${t}/labels/${a}`,{method:"DELETE"});if(!e.ok){const l=await e.json();alert(l.error||"Failed to unassign label")}}catch(e){c(`Label unassign failed: ${e.message}`,!0)}}function U(t){if(t.board){m=w(t.board),y(),c("Synced");return}if(!t.card)return;const a={...t.card,labels:t.card.labels||[]};E(a.id);const e=m.columns.find(l=>l.id===a.column_id||l.id===t.columnId);e&&(e.cards.push(a),e.cards.sort(L),y(),c("Synced"))}function K(t){switch(t.type){case"label-create":{i.find(a=>a.id===t.label.id)||(i.push(t.label),i.sort((a,e)=>a.name.localeCompare(e.name)));break}case"label-update":{const a=i.findIndex(e=>e.id===t.label.id);a!==-1?i[a]=t.label:i.push(t.label),i.sort((e,l)=>e.name.localeCompare(l.name));for(const e of m.columns)for(const l of e.cards)l.labels=(l.labels||[]).map(n=>n.id===t.label.id?t.label:n);break}case"label-delete":{i=i.filter(a=>a.id!==t.labelId),p.delete(t.labelId);for(const a of m.columns)for(const e of a.cards)e.labels=(e.labels||[]).filter(l=>l.id!==t.labelId);break}case"card-label-assign":case"card-label-unassign":{if(t.card){const a={...t.card,labels:t.card.labels||[]};E(a.id);const e=m.columns.find(l=>l.id===a.column_id);e&&(e.cards.push(a),e.cards.sort(L))}break}}y(),c("Synced")}async function G(){const[t,a]=await Promise.all([fetch(`${f}/api/board`),fetch(`${f}/api/labels`)]);if(!t.ok)throw new Error("Could not load board");if(!a.ok)throw new Error("Could not load labels");m=w(await t.json()),i=await a.json(),y()}function Q(){u==null||u.close(),u=new EventSource(`${f}/api/stream`),u.addEventListener("connected",()=>c("Live")),u.addEventListener("mutation",t=>{U(JSON.parse(t.data))}),u.addEventListener("label-mutation",t=>{K(JSON.parse(t.data))}),u.onerror=()=>c("Reconnecting…",!0)}function c(t,a=!1){const e=document.querySelector("#status");e&&(e.textContent=t,e.classList.toggle("warn",a)),clearTimeout($),a&&($=setTimeout(()=>c((u==null?void 0:u.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function V(){g.innerHTML='<div class="loading">Loading board…</div>';try{await G(),Q()}catch(t){g.innerHTML=`<div class="loading error">${d(t.message)}</div>`}}V();
