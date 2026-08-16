(function(){const a=document.createElement("link").relList;if(a&&a.supports&&a.supports("modulepreload"))return;for(const o of document.querySelectorAll('link[rel="modulepreload"]'))n(o);new MutationObserver(o=>{for(const t of o)if(t.type==="childList")for(const l of t.addedNodes)l.tagName==="LINK"&&l.rel==="modulepreload"&&n(l)}).observe(document,{childList:!0,subtree:!0});function r(o){const t={};return o.integrity&&(t.integrity=o.integrity),o.referrerPolicy&&(t.referrerPolicy=o.referrerPolicy),o.crossOrigin==="use-credentials"?t.credentials="include":o.crossOrigin==="anonymous"?t.credentials="omit":t.credentials="same-origin",t}function n(o){if(o.ep)return;o.ep=!0;const t=r(o);fetch(o.href,t)}})();const p="http://localhost:3001",w=document.querySelector("#app");let g={columns:[]},u=[],y=new Set,v=!1,E=null,m=null,$=null;function d(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function A(e){for(const a of g.columns){const r=a.cards.findIndex(n=>n.id===e);if(r!==-1)return{column:a,index:r,card:a.cards[r]}}return null}function I(e){let a=null;for(const r of g.columns){const n=r.cards.findIndex(o=>o.id===e);if(n!==-1){const[o]=r.cards.splice(n,1);a=o}}return a}function S(e){const a=new Set;return{columns:[...e.columns||[]].map(n=>({...n,cards:[...n.cards||[]].filter(o=>a.has(o.id)?!1:(a.add(o.id),!0)).sort(C)})).sort((n,o)=>Number(n.position)-Number(o.position)||n.id.localeCompare(o.id))}}function C(e,a){return Number(e.position)-Number(a.position)||String(e.created_at).localeCompare(String(a.created_at))||e.id.localeCompare(a.id)}function b(){w.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="controls">
      <div class="filter-bar">
        <strong>Filter:</strong>
        ${u.map(e=>`
          <label class="filter-label">
            <input type="checkbox" value="${d(e.id)}" ${y.has(e.id)?"checked":""}>
            <span class="chip" style="background-color: ${d(e.color)}">${d(e.name)}</span>
          </label>
        `).join("")}
        ${y.size>0?'<button id="clear-filters">Clear</button>':""}
      </div>
      <button id="manage-labels-btn">Manage Labels</button>
    </div>
    <main class="board">
      ${g.columns.map(T).join("")}
    </main>
    <dialog id="label-manager">
      <div class="dialog-content">
        <h2>Manage Labels</h2>
        <ul id="label-list">
          ${u.map(e=>`
            <li>
              <form class="edit-label-form" data-label-id="${d(e.id)}">
                <input type="color" name="color" value="${d(e.color)}">
                <input type="text" name="name" value="${d(e.name)}" required>
                <button type="submit">Save</button>
                <button type="button" class="delete-label-btn" data-label-id="${d(e.id)}">Delete</button>
              </form>
            </li>
          `).join("")}
        </ul>
        <form id="create-label-form">
          <input type="color" name="color" value="#ff0000">
          <input type="text" name="name" placeholder="New label name" required>
          <button type="submit">Create</button>
        </form>
        <button id="close-label-manager">Close</button>
      </div>
    </dialog>
  `,j()}function T(e){return`
    <section class="column" data-column-id="${d(e.id)}">
      <h2>${d(e.title)}</h2>
      <form class="add-card" data-column-id="${d(e.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${d(e.id)}">
        ${e.cards.map(N).join("")}
      </div>
    </section>
  `}function N(e){if(y.size>0){const a=new Set((e.labels||[]).map(n=>n.id));let r=!1;for(const n of y)if(a.has(n)){r=!0;break}if(!r)return""}return`
    <article class="card" draggable="true" data-card-id="${d(e.id)}" title="Drag to move">
      <div class="card-labels">
        ${(e.labels||[]).map(a=>`
          <span class="chip" style="background-color: ${d(a.color)}">
            ${d(a.name)}
            <button class="remove-label-btn" data-card-id="${d(e.id)}" data-label-id="${d(a.id)}">&times;</button>
          </span>
        `).join("")}
      </div>
      <div class="card-text">${d(e.text)}</div>
      <div class="card-actions">
        <select class="assign-label-select" data-card-id="${d(e.id)}">
          <option value="">Add label...</option>
          ${u.filter(a=>!(e.labels||[]).some(r=>r.id===a.id)).map(a=>`
            <option value="${d(a.id)}">${d(a.name)}</option>
          `).join("")}
        </select>
      </div>
    </article>
  `}function j(){document.querySelectorAll(".add-card").forEach(t=>{t.addEventListener("submit",async l=>{l.preventDefault();const i=t.elements.text,s=i.value.trim();s&&(i.value="",await U(t.dataset.columnId,s))})}),document.querySelectorAll(".card").forEach(t=>{t.addEventListener("dragstart",l=>{if(l.target.tagName==="BUTTON"||l.target.tagName==="SELECT"||l.target.tagName==="OPTION"){l.preventDefault();return}E=t.dataset.cardId,t.classList.add("dragging"),l.dataTransfer.effectAllowed="move",l.dataTransfer.setData("text/plain",E)}),t.addEventListener("dragend",()=>{t.classList.remove("dragging"),E=null,document.querySelectorAll(".drop-target").forEach(l=>l.classList.remove("drop-target"))})}),document.querySelectorAll(".cards").forEach(t=>{t.addEventListener("dragover",l=>{l.preventDefault(),t.classList.add("drop-target");const i=O(t,l.clientY),s=document.querySelector(".dragging");s&&(i==null?t.appendChild(s):t.insertBefore(s,i))}),t.addEventListener("dragleave",()=>t.classList.remove("drop-target")),t.addEventListener("drop",async l=>{l.preventDefault(),t.classList.remove("drop-target");const i=E||l.dataTransfer.getData("text/plain");if(!i)return;const s=t.dataset.columnId,{beforeId:f,afterId:L}=q(t,i);D(i,s,f,L);try{const h=await fetch(`${p}/api/cards/${encodeURIComponent(i)}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:s,beforeId:f,afterId:L})});if(!h.ok)throw new Error((await h.json()).error||"Move failed")}catch(h){c(`Move rejected: ${h.message}`,!0),await x()}})}),document.querySelectorAll(".filter-label input").forEach(t=>{t.addEventListener("change",l=>{l.target.checked?y.add(l.target.value):y.delete(l.target.value),b()})});const e=document.getElementById("clear-filters");e&&e.addEventListener("click",()=>{y.clear(),b()});const a=document.getElementById("manage-labels-btn"),r=document.getElementById("label-manager"),n=document.getElementById("close-label-manager");v&&r&&!r.open&&r.showModal(),a&&r&&a.addEventListener("click",()=>{v=!0,r.showModal()}),n&&r&&n.addEventListener("click",()=>{v=!1,r.close()}),r&&r.addEventListener("close",()=>{v=!1});const o=document.getElementById("create-label-form");o&&o.addEventListener("submit",async t=>{t.preventDefault();const l=o.elements.name.value.trim(),i=o.elements.color.value;l&&(await M(l,i),o.reset())}),document.querySelectorAll(".edit-label-form").forEach(t=>{t.addEventListener("submit",async l=>{l.preventDefault();const i=t.dataset.labelId,s=t.elements.name.value.trim(),f=t.elements.color.value;s&&await k(i,s,f)})}),document.querySelectorAll(".delete-label-btn").forEach(t=>{t.addEventListener("click",async l=>{const i=l.target.dataset.labelId;await B(i)})}),document.querySelectorAll(".assign-label-select").forEach(t=>{t.addEventListener("change",async l=>{const i=l.target.value;if(i){const s=l.target.dataset.cardId;await P(s,i),l.target.value=""}})}),document.querySelectorAll(".remove-label-btn").forEach(t=>{t.addEventListener("click",async l=>{const i=l.target.dataset.cardId,s=l.target.dataset.labelId;await _(i,s)})})}function O(e,a){return[...e.querySelectorAll(".card:not(.dragging)")].reduce((n,o)=>{const t=o.getBoundingClientRect(),l=a-t.top-t.height/2;return l<0&&l>n.offset?{offset:l,element:o}:n},{offset:Number.NEGATIVE_INFINITY,element:null}).element}function q(e,a){const r=[...e.querySelectorAll(".card")].map(o=>o.dataset.cardId),n=r.indexOf(a);return{afterId:n>0?r[n-1]:null,beforeId:n>=0&&n<r.length-1?r[n+1]:null}}function D(e,a,r,n){const o=I(e);if(!o)return;const t=g.columns.find(f=>f.id===a);if(!t)return;const l=n?t.cards.findIndex(f=>f.id===n):-1,i=r?t.cards.findIndex(f=>f.id===r):-1;let s=t.cards.length;l!==-1?s=l+1:i!==-1&&(s=i),t.cards.splice(s,0,{...o,column_id:a,optimistic:!0})}async function M(e,a){try{const r=await fetch(`${p}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:e,color:a})});if(!r.ok)throw new Error((await r.json()).error||"Create label failed")}catch(r){c(`Create label failed: ${r.message}`,!0)}}async function k(e,a,r){try{const n=await fetch(`${p}/api/labels/${e}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:a,color:r})});if(!n.ok)throw new Error((await n.json()).error||"Update label failed")}catch(n){c(`Update label failed: ${n.message}`,!0)}}async function B(e){try{const a=await fetch(`${p}/api/labels/${e}`,{method:"DELETE"});if(!a.ok)throw new Error((await a.json()).error||"Delete label failed")}catch(a){c(`Delete label failed: ${a.message}`,!0)}}async function P(e,a){try{const r=await fetch(`${p}/api/cards/${e}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:a})});if(!r.ok)throw new Error((await r.json()).error||"Assign label failed")}catch(r){c(`Assign label failed: ${r.message}`,!0)}}async function _(e,a){try{const r=await fetch(`${p}/api/cards/${e}/labels/${a}`,{method:"DELETE"});if(!r.ok)throw new Error((await r.json()).error||"Unassign label failed")}catch(r){c(`Unassign label failed: ${r.message}`,!0)}}async function U(e,a){try{const r=await fetch(`${p}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:e,text:a})});if(!r.ok)throw new Error((await r.json()).error||"Create failed")}catch(r){c(`Create failed: ${r.message}`,!0)}}function F(e){if(e.board){g=S(e.board),b(),c("Synced");return}if(e.type==="create_label"){u.push(e.label),u.sort((n,o)=>n.name.localeCompare(o.name)),b(),c("Synced");return}if(e.type==="update_label"){const n=u.findIndex(o=>o.id===e.label.id);if(n!==-1){u[n]=e.label,u.sort((o,t)=>o.name.localeCompare(t.name));for(const o of g.columns)for(const t of o.cards)if(t.labels){const l=t.labels.findIndex(i=>i.id===e.label.id);l!==-1&&(t.labels[l]=e.label)}b(),c("Synced")}return}if(e.type==="delete_label"){u=u.filter(n=>n.id!==e.labelId),y.delete(e.labelId);for(const n of g.columns)for(const o of n.cards)o.labels&&(o.labels=o.labels.filter(t=>t.id!==e.labelId));b(),c("Synced");return}if(e.type==="assign_label"||e.type==="unassign_label"){if(e.card){const n=A(e.card.id);n&&(n.card.labels=e.card.labels,b(),c("Synced"))}return}if(!e.card)return;const a=e.card;I(a.id);const r=g.columns.find(n=>n.id===a.column_id||n.id===e.columnId);r&&(r.cards.push(a),r.cards.sort(C),b(),c("Synced"))}async function x(){const[e,a]=await Promise.all([fetch(`${p}/api/board`),fetch(`${p}/api/labels`)]);if(!e.ok)throw new Error("Could not load board");if(!a.ok)throw new Error("Could not load labels");g=S(await e.json()),u=await a.json(),b()}function J(){m==null||m.close(),m=new EventSource(`${p}/api/stream`),m.addEventListener("connected",()=>c("Live")),m.addEventListener("mutation",e=>{F(JSON.parse(e.data))}),m.onerror=()=>c("Reconnecting…",!0)}function c(e,a=!1){const r=document.querySelector("#status");r&&(r.textContent=e,r.classList.toggle("warn",a)),clearTimeout($),a&&($=setTimeout(()=>c((m==null?void 0:m.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function R(){w.innerHTML='<div class="loading">Loading board…</div>';try{await x(),J()}catch(e){w.innerHTML=`<div class="loading error">${d(e.message)}</div>`}}R();
