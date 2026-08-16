(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))o(n);new MutationObserver(n=>{for(const s of n)if(s.type==="childList")for(const r of s.addedNodes)r.tagName==="LINK"&&r.rel==="modulepreload"&&o(r)}).observe(document,{childList:!0,subtree:!0});function t(n){const s={};return n.integrity&&(s.integrity=n.integrity),n.referrerPolicy&&(s.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?s.credentials="include":n.crossOrigin==="anonymous"?s.credentials="omit":s.credentials="same-origin",s}function o(n){if(n.ep)return;n.ep=!0;const s=t(n);fetch(n.href,s)}})();const g="http://localhost:3001",I=document.querySelector("#app");let $={columns:[]},m=[],y=new Set,E=null,v=null,C=null,h=null,L=!1;function i(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function x(e){let a=null;for(const t of $.columns){const o=t.cards.findIndex(n=>n.id===e);if(o!==-1){const[n]=t.cards.splice(o,1);a=n}}return a}function S(e){const a=new Set;return{columns:[...e.columns||[]].map(o=>({...o,cards:[...o.cards||[]].filter(n=>a.has(n.id)?!1:(a.add(n.id),!0)).map(n=>({...n,labels:n.labels||[]})).sort(k)})).sort((o,n)=>Number(o.position)-Number(n.position)||o.id.localeCompare(n.id))}}function k(e,a){return Number(e.position)-Number(a.position)||String(e.created_at).localeCompare(String(a.created_at))||e.id.localeCompare(a.id)}function q(e){if(y.size===0)return!0;const a=new Set((e.labels||[]).map(t=>t.id));for(const t of y)if(a.has(t))return!0;return!1}function f(){const e=window.scrollY;I.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-right">
        <button class="btn-label-manager" id="open-label-manager">🏷 Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${O()}
    <main class="board">
      ${$.columns.map(j).join("")}
    </main>
    ${L?M():""}
  `,window.scrollTo(0,e),D()}function O(){return m.length===0?"":`
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${m.map(e=>`<button
          class="filter-chip${y.has(e.id)?" active":""}"
          data-filter-label-id="${i(e.id)}"
          style="--chip-color: ${i(e.color)}"
          title="${i(e.name)}"
        >${i(e.name)}</button>`).join("")}
      ${y.size>0?'<button class="filter-clear" id="clear-filters">✕ Clear</button>':""}
    </div>
  `}function j(e){return`
    <section class="column" data-column-id="${i(e.id)}">
      <h2>${i(e.title)}</h2>
      <form class="add-card" data-column-id="${i(e.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${i(e.id)}">
        ${e.cards.map(a=>N(a,q(a))).join("")}
      </div>
    </section>
  `}function N(e,a=!0){const t=e.labels||[],o=t.length>0?`<div class="card-chips">${t.map(r=>`<span class="chip" style="background:${i(r.color)}" title="${i(r.name)}">${i(r.name)}</span>`).join("")}</div>`:"",s=h===e.id?P(e):"";return`
    <article
      class="card${a?"":" card-hidden"}"
      draggable="${a?"true":"false"}"
      data-card-id="${i(e.id)}"
      title="${a?"Drag to move":""}"
    >
      <div class="card-text">${i(e.text)}</div>
      ${o}
      <div class="card-actions">
        <button class="btn-assign-label" data-card-id="${i(e.id)}" title="Manage labels">🏷</button>
      </div>
      ${s}
    </article>
  `}function P(e){const a=new Set((e.labels||[]).map(t=>t.id));return m.length===0?`
      <div class="label-popover" data-popover-card-id="${i(e.id)}">
        <div class="popover-empty">No labels yet. Create one via the Labels button.</div>
      </div>
    `:`
    <div class="label-popover" data-popover-card-id="${i(e.id)}">
      <div class="popover-title">Assign labels</div>
      ${m.map(t=>{const o=a.has(t.id);return`
          <label class="popover-label-row">
            <input
              type="checkbox"
              class="label-assign-checkbox"
              data-card-id="${i(e.id)}"
              data-label-id="${i(t.id)}"
              ${o?"checked":""}
            />
            <span class="popover-chip" style="background:${i(t.color)}">${i(t.name)}</span>
          </label>
        `}).join("")}
    </div>
  `}function M(){return`
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal" id="label-manager-modal" role="dialog" aria-modal="true" aria-label="Label Manager">
        <div class="modal-header">
          <h2>Label Manager</h2>
          <button class="modal-close" id="close-label-manager" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <form class="label-create-form" id="label-create-form">
            <input
              type="text"
              name="name"
              placeholder="Label name…"
              maxlength="100"
              autocomplete="off"
              required
            />
            <input type="color" name="color" value="#3b82f6" title="Pick a color" />
            <button type="submit">Create</button>
          </form>
          <div id="label-create-error" class="label-error" style="display:none"></div>
          <ul class="label-list" id="label-list">
            ${m.length===0?'<li class="label-list-empty">No labels yet.</li>':m.map(T).join("")}
          </ul>
        </div>
      </div>
    </div>
  `}function T(e){return`
    <li class="label-row" data-label-id="${i(e.id)}">
      <span class="label-swatch" style="background:${i(e.color)}"></span>
      <span class="label-row-name" data-label-id="${i(e.id)}">${i(e.name)}</span>
      <div class="label-row-actions">
        <button class="btn-edit-label" data-label-id="${i(e.id)}" title="Rename / recolor">✏️</button>
        <button class="btn-delete-label" data-label-id="${i(e.id)}" title="Delete label">🗑</button>
      </div>
    </li>
  `}function D(){var e,a,t,o,n,s;(e=document.getElementById("open-label-manager"))==null||e.addEventListener("click",()=>{L=!0,f()}),(a=document.getElementById("close-label-manager"))==null||a.addEventListener("click",()=>{L=!1,f()}),(t=document.getElementById("label-manager-overlay"))==null||t.addEventListener("click",r=>{r.target===document.getElementById("label-manager-overlay")&&(L=!1,f())}),(o=document.getElementById("label-create-form"))==null||o.addEventListener("submit",async r=>{r.preventDefault();const l=r.target,d=l.elements.name.value.trim(),c=l.elements.color.value,p=document.getElementById("label-create-error");if(p.style.display="none",!!d)try{const u=await fetch(`${g}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:d,color:c})});if(!u.ok){const w=await u.json();p.textContent=w.error||"Failed to create label",p.style.display="block";return}l.elements.name.value=""}catch(u){p.textContent=u.message,p.style.display="block"}}),(n=document.getElementById("label-list"))==null||n.addEventListener("click",async r=>{const l=r.target.closest(".btn-edit-label"),d=r.target.closest(".btn-delete-label");if(l){const c=l.dataset.labelId,p=m.find(u=>u.id===c);if(!p)return;A(c,p)}if(d){const c=d.dataset.labelId,p=m.find(u=>u.id===c);if(!p||!confirm(`Delete label "${p.name}"? It will be removed from all cards.`))return;try{const u=await fetch(`${g}/api/labels/${encodeURIComponent(c)}`,{method:"DELETE"});if(!u.ok&&u.status!==404){const w=await u.json().catch(()=>({}));b(`Delete failed: ${w.error||u.statusText}`,!0)}y.delete(c)}catch(u){b(`Delete failed: ${u.message}`,!0)}}}),document.querySelectorAll(".filter-chip").forEach(r=>{r.addEventListener("click",()=>{const l=r.dataset.filterLabelId;y.has(l)?y.delete(l):y.add(l),f()})}),(s=document.getElementById("clear-filters"))==null||s.addEventListener("click",()=>{y.clear(),f()}),document.querySelectorAll(".add-card").forEach(r=>{r.addEventListener("submit",async l=>{l.preventDefault();const d=r.elements.text,c=d.value.trim();if(!c)return;d.value="";const p=r.dataset.columnId;await F(p,c)})}),document.querySelectorAll(".btn-assign-label").forEach(r=>{r.addEventListener("click",l=>{l.stopPropagation();const d=r.dataset.cardId;h===d?h=null:h=d,f()})}),document.querySelectorAll(".label-assign-checkbox").forEach(r=>{r.addEventListener("change",async l=>{const d=r.dataset.cardId,c=r.dataset.labelId;l.target.checked?await _(d,c):await z(d,c)})}),document.addEventListener("click",B,{once:!0}),document.querySelectorAll('.card[draggable="true"]').forEach(r=>{r.addEventListener("dragstart",l=>{E=r.dataset.cardId,r.classList.add("dragging"),l.dataTransfer.effectAllowed="move"}),r.addEventListener("dragend",()=>{E=null,r.classList.remove("dragging"),document.querySelectorAll(".cards.drop-target").forEach(l=>l.classList.remove("drop-target"))})}),document.querySelectorAll(".cards").forEach(r=>{r.addEventListener("dragover",l=>{E&&(l.preventDefault(),l.dataTransfer.dropEffect="move",r.classList.add("drop-target"))}),r.addEventListener("dragleave",l=>{r.contains(l.relatedTarget)||r.classList.remove("drop-target")}),r.addEventListener("drop",async l=>{if(l.preventDefault(),r.classList.remove("drop-target"),!E)return;const d=r.dataset.columnId,c=E,{afterId:p,beforeId:u}=U(r,c);H(c,d,u,p),f(),await J(c,d,u,p)})})}function B(e){if(!h)return;const a=document.querySelector(`.label-popover[data-popover-card-id="${h}"]`),t=document.querySelector(`.btn-assign-label[data-card-id="${h}"]`);a&&!a.contains(e.target)&&t&&!t.contains(e.target)&&(h=null,f())}function A(e,a){const t=document.querySelector(`.label-row[data-label-id="${e}"]`);if(!t)return;t.innerHTML=`
    <form class="label-edit-form" data-label-id="${i(e)}">
      <input type="color" name="color" value="${i(a.color)}" title="Pick a color" />
      <input type="text" name="name" value="${i(a.name)}" maxlength="100" autocomplete="off" required />
      <button type="submit">Save</button>
      <button type="button" class="btn-cancel-edit">Cancel</button>
    </form>
    <div class="label-edit-error" style="display:none"></div>
  `;const o=t.querySelector(".label-edit-form");o.elements.name.focus(),o.elements.name.select(),o.querySelector(".btn-cancel-edit").addEventListener("click",()=>{t.innerHTML=T(a).replace(/<li[^>]*>|<\/li>/g,""),R(t,e,a)}),o.addEventListener("submit",async n=>{n.preventDefault();const s=o.elements.name.value.trim(),r=o.elements.color.value,l=t.querySelector(".label-edit-error");if(l.style.display="none",!!s)try{const d=await fetch(`${g}/api/labels/${encodeURIComponent(e)}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:s,color:r})});if(!d.ok){const c=await d.json();l.textContent=c.error||"Failed to update label",l.style.display="block";return}}catch(d){l.textContent=d.message,l.style.display="block"}})}function R(e,a,t){var o,n;(o=e.querySelector(".btn-edit-label"))==null||o.addEventListener("click",()=>A(a,t)),(n=e.querySelector(".btn-delete-label"))==null||n.addEventListener("click",async()=>{if(confirm(`Delete label "${t.name}"? It will be removed from all cards.`))try{await fetch(`${g}/api/labels/${encodeURIComponent(a)}`,{method:"DELETE"}),y.delete(a)}catch(s){b(`Delete failed: ${s.message}`,!0)}})}function U(e,a){const t=[...e.querySelectorAll(".card")].map(n=>n.dataset.cardId),o=t.indexOf(a);return{afterId:o>0?t[o-1]:null,beforeId:o>=0&&o<t.length-1?t[o+1]:null}}function H(e,a,t,o){const n=x(e);if(!n)return;const s=$.columns.find(c=>c.id===a);if(!s)return;const r=o?s.cards.findIndex(c=>c.id===o):-1,l=t?s.cards.findIndex(c=>c.id===t):-1;let d=s.cards.length;r!==-1?d=r+1:l!==-1&&(d=l),s.cards.splice(d,0,{...n,column_id:a,optimistic:!0})}async function F(e,a){try{const t=await fetch(`${g}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:e,text:a})});if(!t.ok)throw new Error((await t.json()).error||"Create failed")}catch(t){b(`Create failed: ${t.message}`,!0)}}async function J(e,a,t,o){try{const n=await fetch(`${g}/api/cards/${encodeURIComponent(e)}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:a,beforeId:t,afterId:o})});if(!n.ok)throw new Error((await n.json()).error||"Move failed")}catch(n){b(`Move failed: ${n.message}`,!0)}}async function _(e,a){try{const t=await fetch(`${g}/api/cards/${encodeURIComponent(e)}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:a})});if(!t.ok)throw new Error((await t.json()).error||"Assign failed")}catch(t){b(`Assign failed: ${t.message}`,!0)}}async function z(e,a){try{const t=await fetch(`${g}/api/cards/${encodeURIComponent(e)}/labels/${encodeURIComponent(a)}`,{method:"DELETE"});if(!t.ok)throw new Error((await t.json()).error||"Unassign failed")}catch(t){b(`Unassign failed: ${t.message}`,!0)}}async function K(){const e=await fetch(`${g}/api/labels`);if(!e.ok)throw new Error("Could not load labels");m=await e.json()}function Y(e){if(e.board){$=S(e.board),f(),b("Synced");return}if(!e.card)return;const a=e.card;x(a.id);const t=$.columns.find(o=>o.id===a.column_id||o.id===e.columnId);t&&(t.cards.push(a),t.cards.sort(k),f(),b("Synced"))}function G(e){e.board&&($=S(e.board));const{type:a,label:t,labelId:o}=e;if(a==="label-create"&&t)m.find(n=>n.id===t.id)||(m.push(t),m.sort((n,s)=>n.name.localeCompare(s.name)));else if(a==="label-update"&&t){const n=m.findIndex(s=>s.id===t.id);n!==-1?m[n]=t:m.push(t),m.sort((s,r)=>s.name.localeCompare(r.name))}else a==="label-delete"&&o&&(m=m.filter(n=>n.id!==o),y.delete(o));f(),b("Synced")}async function Q(){const e=await fetch(`${g}/api/board`);if(!e.ok)throw new Error("Could not load board");$=S(await e.json()),f()}function V(){v==null||v.close(),v=new EventSource(`${g}/api/stream`),v.addEventListener("connected",()=>b("Live")),v.addEventListener("mutation",e=>{Y(JSON.parse(e.data))}),v.addEventListener("label-mutation",e=>{G(JSON.parse(e.data))}),v.onerror=()=>b("Reconnecting…",!0)}function b(e,a=!1){const t=document.querySelector("#status");t&&(t.textContent=e,t.classList.toggle("warn",a)),clearTimeout(C),a&&(C=setTimeout(()=>b((v==null?void 0:v.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function W(){I.innerHTML='<div class="loading">Loading board…</div>';try{await Promise.all([Q(),K()]),f(),V()}catch(e){I.innerHTML=`<div class="loading error">${i(e.message)}</div>`}}W();
