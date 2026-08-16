(function(){const n=document.createElement("link").relList;if(n&&n.supports&&n.supports("modulepreload"))return;for(const e of document.querySelectorAll('link[rel="modulepreload"]'))l(e);new MutationObserver(e=>{for(const a of e)if(a.type==="childList")for(const o of a.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&l(o)}).observe(document,{childList:!0,subtree:!0});function r(e){const a={};return e.integrity&&(a.integrity=e.integrity),e.referrerPolicy&&(a.referrerPolicy=e.referrerPolicy),e.crossOrigin==="use-credentials"?a.credentials="include":e.crossOrigin==="anonymous"?a.credentials="omit":a.credentials="same-origin",a}function l(e){if(e.ep)return;e.ep=!0;const a=r(e);fetch(e.href,a)}})();const f="http://localhost:3001",L=document.querySelector("#app");let p={columns:[]},b=[],v=new Set,$=null,m=null,S=null,I=!1,g=null,w=null;function d(t){return String(t).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function C(t){let n=null;for(const r of p.columns){const l=r.cards.findIndex(e=>e.id===t);if(l!==-1){const[e]=r.cards.splice(l,1);n=e}}return n}function y(t){const n=new Set;return{columns:[...t.columns||[]].map(l=>({...l,cards:[...l.cards||[]].filter(e=>n.has(e.id)?!1:(n.add(e.id),!0)).sort(A)})).sort((l,e)=>Number(l.position)-Number(e.position)||l.id.localeCompare(e.id))}}function A(t,n){return Number(t.position)-Number(n.position)||String(t.created_at).localeCompare(String(n.created_at))||t.id.localeCompare(n.id)}function u(){L.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="btn">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    <div class="filter-bar">
      <span>Filter by labels:</span>
      <div class="filter-labels">
        ${b.map(t=>`
          <label class="filter-label ${v.has(t.id)?"selected":""}" style="--label-color: ${d(t.color)}">
            <input type="checkbox" value="${d(t.id)}" ${v.has(t.id)?"checked":""} class="filter-checkbox" />
            ${d(t.name)}
          </label>
        `).join("")}
        ${v.size>0?'<button id="clear-filters-btn" class="btn-small">Clear</button>':""}
      </div>
    </div>
    <main class="board">
      ${p.columns.map(q).join("")}
    </main>
    ${I?k():""}
  `,N()}function k(){return`
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal">
        <div class="modal-header">
          <h2>Manage Labels</h2>
          <button id="close-label-manager" class="btn-close">&times;</button>
        </div>
        <div class="modal-body">
          <ul class="label-list">
            ${b.map(t=>`
              <li class="label-item">
                ${g===t.id?`
                  <form class="edit-label-form" data-label-id="${d(t.id)}">
                    <input type="text" name="name" value="${d(t.name)}" required />
                    <input type="color" name="color" value="${d(t.color)}" required />
                    <button type="submit" class="btn-small">Save</button>
                    <button type="button" class="btn-small cancel-edit-label">Cancel</button>
                  </form>
                `:`
                  <div class="label-display">
                    <span class="label-chip" style="background-color: ${d(t.color)}">${d(t.name)}</span>
                    <div class="label-actions">
                      <button class="btn-small edit-label-btn" data-label-id="${d(t.id)}">Edit</button>
                      <button class="btn-small delete-label-btn" data-label-id="${d(t.id)}">Delete</button>
                    </div>
                  </div>
                `}
              </li>
            `).join("")}
          </ul>
          <form id="create-label-form" class="create-label-form">
            <input type="text" name="name" placeholder="New label name" required />
            <input type="color" name="color" value="#3b82f6" required />
            <button type="submit" class="btn">Create Label</button>
          </form>
        </div>
      </div>
    </div>
  `}function q(t){const n=t.cards.filter(r=>v.size===0?!0:(r.labels||[]).some(l=>v.has(l.id)));return`
    <section class="column" data-column-id="${d(t.id)}">
      <h2>${d(t.title)}</h2>
      <form class="add-card" data-column-id="${d(t.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${d(t.id)}">
        ${n.map(T).join("")}
      </div>
    </section>
  `}function T(t){const n=t.labels||[];return`
    <article class="card" draggable="true" data-card-id="${d(t.id)}" title="Drag to move">
      <div class="card-labels">
        ${n.map(r=>`<span class="label-chip" style="background-color: ${d(r.color)}">${d(r.name)}</span>`).join("")}
        <button class="btn-icon add-label-btn" data-card-id="${d(t.id)}">+</button>
      </div>
      <div class="card-text">${d(t.text)}</div>
      ${w===t.id?j(t):""}
    </article>
  `}function j(t){const n=new Set((t.labels||[]).map(r=>r.id));return`
    <div class="card-label-menu">
      <div class="card-label-menu-header">
        <span>Labels</span>
        <button class="btn-close close-card-label-menu">&times;</button>
      </div>
      <div class="card-label-menu-body">
        ${b.map(r=>`
          <label class="card-label-option">
            <input type="checkbox" class="toggle-card-label" data-card-id="${d(t.id)}" data-label-id="${d(r.id)}" ${n.has(r.id)?"checked":""} />
            <span class="label-chip" style="background-color: ${d(r.color)}">${d(r.name)}</span>
          </label>
        `).join("")}
      </div>
    </div>
  `}function N(){var t,n,r,l;(t=document.getElementById("manage-labels-btn"))==null||t.addEventListener("click",()=>{I=!0,u()}),(n=document.getElementById("close-label-manager"))==null||n.addEventListener("click",()=>{I=!1,g=null,u()}),(r=document.getElementById("create-label-form"))==null||r.addEventListener("submit",async e=>{e.preventDefault();const a=e.target,o=a.elements.name.value.trim(),c=a.elements.color.value;if(o)try{const i=await fetch(`${f}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:o,color:c})});if(!i.ok)throw new Error((await i.json()).error);a.reset()}catch(i){alert(i.message)}}),document.querySelectorAll(".edit-label-btn").forEach(e=>{e.addEventListener("click",()=>{g=e.dataset.labelId,u()})}),document.querySelectorAll(".cancel-edit-label").forEach(e=>{e.addEventListener("click",()=>{g=null,u()})}),document.querySelectorAll(".edit-label-form").forEach(e=>{e.addEventListener("submit",async a=>{a.preventDefault();const o=e.dataset.labelId,c=e.elements.name.value.trim(),i=e.elements.color.value;if(c)try{const s=await fetch(`${f}/api/labels/${encodeURIComponent(o)}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:c,color:i})});if(!s.ok)throw new Error((await s.json()).error);g=null}catch(s){alert(s.message)}})}),document.querySelectorAll(".delete-label-btn").forEach(e=>{e.addEventListener("click",async()=>{const a=e.dataset.labelId;if(confirm("Delete this label?"))try{const o=await fetch(`${f}/api/labels/${encodeURIComponent(a)}`,{method:"DELETE"});if(!o.ok)throw new Error((await o.json()).error)}catch(o){alert(o.message)}})}),document.querySelectorAll(".filter-checkbox").forEach(e=>{e.addEventListener("change",a=>{a.target.checked?v.add(a.target.value):v.delete(a.target.value),u()})}),(l=document.getElementById("clear-filters-btn"))==null||l.addEventListener("click",()=>{v.clear(),u()}),document.querySelectorAll(".add-label-btn").forEach(e=>{e.addEventListener("click",a=>{a.stopPropagation(),w=e.dataset.cardId,u()})}),document.querySelectorAll(".close-card-label-menu").forEach(e=>{e.addEventListener("click",a=>{a.stopPropagation(),w=null,u()})}),document.querySelectorAll(".toggle-card-label").forEach(e=>{e.addEventListener("change",async a=>{const o=e.dataset.cardId,c=e.dataset.labelId,i=a.target.checked;try{const s=await fetch(`${f}/api/cards/${encodeURIComponent(o)}/labels${i?"":`/${encodeURIComponent(c)}`}`,{method:i?"POST":"DELETE",headers:i?{"Content-Type":"application/json"}:void 0,body:i?JSON.stringify({labelId:c}):void 0});if(!s.ok)throw new Error((await s.json()).error)}catch(s){alert(s.message),a.target.checked=!i}})}),document.querySelectorAll(".add-card").forEach(e=>{e.addEventListener("submit",async a=>{a.preventDefault();const o=e.elements.text,c=o.value.trim();c&&(o.value="",await P(e.dataset.columnId,c))})}),document.querySelectorAll(".card").forEach(e=>{e.addEventListener("dragstart",a=>{$=e.dataset.cardId,e.classList.add("dragging"),a.dataTransfer.effectAllowed="move",a.dataTransfer.setData("text/plain",$)}),e.addEventListener("dragend",()=>{e.classList.remove("dragging"),$=null,document.querySelectorAll(".drop-target").forEach(a=>a.classList.remove("drop-target"))})}),document.querySelectorAll(".cards").forEach(e=>{e.addEventListener("dragover",a=>{a.preventDefault(),e.classList.add("drop-target");const o=O(e,a.clientY),c=document.querySelector(".dragging");c&&(o==null?e.appendChild(c):e.insertBefore(c,o))}),e.addEventListener("dragleave",()=>e.classList.remove("drop-target")),e.addEventListener("drop",async a=>{a.preventDefault(),e.classList.remove("drop-target");const o=$||a.dataTransfer.getData("text/plain");if(!o)return;const c=e.dataset.columnId,{beforeId:i,afterId:s}=D(e,o);M(o,c,i,s);try{const E=await fetch(`${f}/api/cards/${encodeURIComponent(o)}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:c,beforeId:i,afterId:s})});if(!E.ok)throw new Error((await E.json()).error||"Move failed")}catch(E){h(`Move rejected: ${E.message}`,!0),await x()}})})}function O(t,n){return[...t.querySelectorAll(".card:not(.dragging)")].reduce((l,e)=>{const a=e.getBoundingClientRect(),o=n-a.top-a.height/2;return o<0&&o>l.offset?{offset:o,element:e}:l},{offset:Number.NEGATIVE_INFINITY,element:null}).element}function D(t,n){const r=[...t.querySelectorAll(".card")].map(e=>e.dataset.cardId),l=r.indexOf(n);return{afterId:l>0?r[l-1]:null,beforeId:l>=0&&l<r.length-1?r[l+1]:null}}function M(t,n,r,l){const e=C(t);if(!e)return;const a=p.columns.find(s=>s.id===n);if(!a)return;const o=l?a.cards.findIndex(s=>s.id===l):-1,c=r?a.cards.findIndex(s=>s.id===r):-1;let i=a.cards.length;o!==-1?i=o+1:c!==-1&&(i=c),a.cards.splice(i,0,{...e,column_id:n,optimistic:!0})}async function P(t,n){try{const r=await fetch(`${f}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:t,text:n})});if(!r.ok)throw new Error((await r.json()).error||"Create failed")}catch(r){h(`Create failed: ${r.message}`,!0)}}function _(t){if(t.type==="create_label"){b.push(t.label),b.sort((l,e)=>l.name.localeCompare(e.name)),u();return}if(t.type==="update_label"){const l=b.findIndex(e=>e.id===t.label.id);l!==-1&&(b[l]=t.label,b.sort((e,a)=>e.name.localeCompare(a.name))),t.board&&(p=y(t.board)),u();return}if(t.type==="delete_label"){b=b.filter(l=>l.id!==t.labelId),v.delete(t.labelId),t.board&&(p=y(t.board)),u();return}if(t.type==="assign_label"||t.type==="unassign_label"){t.board&&(p=y(t.board)),u();return}if(t.board){p=y(t.board),u(),h("Synced");return}if(!t.card)return;const n=t.card;C(n.id);const r=p.columns.find(l=>l.id===n.column_id||l.id===t.columnId);r&&(r.cards.push(n),r.cards.sort(A),u(),h("Synced"))}async function x(){const[t,n]=await Promise.all([fetch(`${f}/api/board`),fetch(`${f}/api/labels`)]);if(!t.ok||!n.ok)throw new Error("Could not load board or labels");p=y(await t.json()),b=await n.json(),u()}function R(){m==null||m.close(),m=new EventSource(`${f}/api/stream`),m.addEventListener("connected",()=>h("Live")),m.addEventListener("mutation",t=>{_(JSON.parse(t.data))}),m.onerror=()=>h("Reconnecting…",!0)}function h(t,n=!1){const r=document.querySelector("#status");r&&(r.textContent=t,r.classList.toggle("warn",n)),clearTimeout(S),n&&(S=setTimeout(()=>h((m==null?void 0:m.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function B(){L.innerHTML='<div class="loading">Loading board…</div>';try{await x(),R()}catch(t){L.innerHTML=`<div class="loading error">${d(t.message)}</div>`}}B();
