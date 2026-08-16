(function(){const l=document.createElement("link").relList;if(l&&l.supports&&l.supports("modulepreload"))return;for(const a of document.querySelectorAll('link[rel="modulepreload"]'))e(a);new MutationObserver(a=>{for(const n of a)if(n.type==="childList")for(const o of n.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&e(o)}).observe(document,{childList:!0,subtree:!0});function r(a){const n={};return a.integrity&&(n.integrity=a.integrity),a.referrerPolicy&&(n.referrerPolicy=a.referrerPolicy),a.crossOrigin==="use-credentials"?n.credentials="include":a.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function e(a){if(a.ep)return;a.ep=!0;const n=r(a);fetch(a.href,n)}})();const s="http://localhost:3001",I=document.querySelector("#app");let p={columns:[]},u=[],y=new Set,E=null,f=null,w=null;function c(t){return String(t).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function $(t){for(const l of p.columns){const r=l.cards.findIndex(e=>e.id===t);if(r!==-1)return{column:l,index:r,card:l.cards[r]}}return null}function L(t){let l=null;for(const r of p.columns){const e=r.cards.findIndex(a=>a.id===t);if(e!==-1){const[a]=r.cards.splice(e,1);l=a}}return l}function S(t){const l=new Set;return{columns:[...t.columns||[]].map(e=>({...e,cards:[...e.cards||[]].filter(a=>l.has(a.id)?!1:(l.add(a.id),!0)).sort(A)})).sort((e,a)=>Number(e.position)-Number(a.position)||e.id.localeCompare(a.id))}}function A(t,l){return Number(t.position)-Number(l.position)||String(t.created_at).localeCompare(String(l.created_at))||t.id.localeCompare(l.id)}function m(){I.innerHTML=`
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
        ${u.map(t=>`
          <label class="filter-label">
            <input type="checkbox" value="${c(t.id)}" ${y.has(t.id)?"checked":""}>
            <span class="chip" style="background-color: ${c(t.color)}">${c(t.name)}</span>
          </label>
        `).join("")}
        ${y.size>0?'<button id="clear-filter">Clear</button>':""}
      </div>
      <div class="label-manager">
        <strong>Labels:</strong>
        <form id="add-label-form">
          <input type="text" name="name" placeholder="New label name" required>
          <input type="color" name="color" value="#ff0000" required>
          <button type="submit">Add</button>
        </form>
        <div class="label-list">
          ${u.map(t=>`
            <div class="label-item" data-label-id="${c(t.id)}">
              <input type="color" class="edit-label-color" value="${c(t.color)}">
              <input type="text" class="edit-label-name" value="${c(t.name)}">
              <button class="delete-label">X</button>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
    <main class="board">
      ${p.columns.map(T).join("")}
    </main>
  `,q()}function T(t){const l=t.cards.filter(r=>y.size===0?!0:r.labels&&r.labels.some(e=>y.has(e.id)));return`
    <section class="column" data-column-id="${c(t.id)}">
      <h2>${c(t.title)}</h2>
      <form class="add-card" data-column-id="${c(t.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${c(t.id)}">
        ${l.map(j).join("")}
      </div>
    </section>
  `}function j(t){return`
    <article class="card" draggable="true" data-card-id="${c(t.id)}" title="Drag to move">
      <div class="card-labels">
        ${(t.labels||[]).map(l=>`
          <span class="chip" style="background-color: ${c(l.color)}">
            ${c(l.name)}
            <button class="remove-card-label" data-label-id="${c(l.id)}">&times;</button>
          </span>
        `).join("")}
      </div>
      <div class="card-text">${c(t.text)}</div>
      <div class="card-actions">
        <select class="add-card-label">
          <option value="">Add label...</option>
          ${u.filter(l=>!(t.labels||[]).some(r=>r.id===l.id)).map(l=>`
            <option value="${c(l.id)}">${c(l.name)}</option>
          `).join("")}
        </select>
      </div>
    </article>
  `}function q(){document.querySelectorAll(".add-card").forEach(r=>{r.addEventListener("submit",async e=>{e.preventDefault();const a=r.elements.text,n=a.value.trim();n&&(a.value="",await P(r.dataset.columnId,n))})}),document.querySelectorAll(".card").forEach(r=>{r.addEventListener("dragstart",e=>{E=r.dataset.cardId,r.classList.add("dragging"),e.dataTransfer.effectAllowed="move",e.dataTransfer.setData("text/plain",E)}),r.addEventListener("dragend",()=>{E=null,r.classList.remove("dragging"),document.querySelectorAll(".cards").forEach(e=>e.classList.remove("drop-target"))})}),document.querySelectorAll(".cards").forEach(r=>{r.addEventListener("dragover",e=>{e.preventDefault(),e.dataTransfer.dropEffect="move",r.classList.add("drop-target")}),r.addEventListener("dragleave",e=>{r.contains(e.relatedTarget)||r.classList.remove("drop-target")}),r.addEventListener("drop",async e=>{e.preventDefault(),r.classList.remove("drop-target");const a=e.dataTransfer.getData("text/plain");if(!a)return;const n=r.dataset.columnId,o=N(r,e.clientY);let d=null,b=null;if(o){d=o.dataset.cardId;const i=o.previousElementSibling;i&&i.classList.contains("card")&&(b=i.dataset.cardId)}else{const i=r.lastElementChild;i&&i.classList.contains("card")&&(b=i.dataset.cardId)}const h=$(a);if(!h)return;const{beforeId:x,afterId:C}=O(h.column.id,a);if(!(h.column.id===n&&x===d&&C===b)){k(a,n,d,b),m();try{const i=await fetch(`${s}/api/cards/${a}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:n,beforeId:d,afterId:b})});if(!i.ok)throw new Error((await i.json()).error||"Move failed")}catch(i){g(`Move failed: ${i.message}`,!0),await v()}}})}),document.querySelectorAll(".filter-label input").forEach(r=>{r.addEventListener("change",e=>{e.target.checked?y.add(e.target.value):y.delete(e.target.value),m()})});const t=document.getElementById("clear-filter");t&&t.addEventListener("click",()=>{y.clear(),m()});const l=document.getElementById("add-label-form");l&&l.addEventListener("submit",async r=>{r.preventDefault();const e=l.elements.name.value.trim(),a=l.elements.color.value;if(e)try{const n=await fetch(`${s}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:e,color:a})});if(!n.ok)throw new Error((await n.json()).error||"Failed to create label");l.reset()}catch(n){alert(n.message)}}),document.querySelectorAll(".edit-label-name").forEach(r=>{r.addEventListener("change",async e=>{const a=e.target.closest(".label-item").dataset.labelId,n=e.target.value.trim(),o=e.target.closest(".label-item").querySelector(".edit-label-color").value;if(n)try{const d=await fetch(`${s}/api/labels/${a}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:n,color:o})});if(!d.ok)throw new Error((await d.json()).error||"Failed to update label")}catch(d){alert(d.message),await v()}})}),document.querySelectorAll(".edit-label-color").forEach(r=>{r.addEventListener("change",async e=>{const a=e.target.closest(".label-item").dataset.labelId,n=e.target.value,o=e.target.closest(".label-item").querySelector(".edit-label-name").value.trim();try{const d=await fetch(`${s}/api/labels/${a}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:o,color:n})});if(!d.ok)throw new Error((await d.json()).error||"Failed to update label")}catch(d){alert(d.message),await v()}})}),document.querySelectorAll(".delete-label").forEach(r=>{r.addEventListener("click",async e=>{const a=e.target.closest(".label-item").dataset.labelId;try{const n=await fetch(`${s}/api/labels/${a}`,{method:"DELETE"});if(!n.ok)throw new Error((await n.json()).error||"Failed to delete label")}catch(n){alert(n.message)}})}),document.querySelectorAll(".add-card-label").forEach(r=>{r.addEventListener("change",async e=>{const a=e.target.value;if(!a)return;const n=e.target.closest(".card").dataset.cardId;try{const o=await fetch(`${s}/api/cards/${n}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:a})});if(!o.ok)throw new Error((await o.json()).error||"Failed to add label to card")}catch(o){alert(o.message)}})}),document.querySelectorAll(".remove-card-label").forEach(r=>{r.addEventListener("click",async e=>{const a=e.target.dataset.labelId,n=e.target.closest(".card").dataset.cardId;try{const o=await fetch(`${s}/api/cards/${n}/labels/${a}`,{method:"DELETE"});if(!o.ok)throw new Error((await o.json()).error||"Failed to remove label from card")}catch(o){alert(o.message)}})})}function N(t,l){return[...t.querySelectorAll(".card:not(.dragging)")].reduce((e,a)=>{const n=a.getBoundingClientRect(),o=l-n.top-n.height/2;return o<0&&o>e.offset?{offset:o,element:a}:e},{offset:Number.NEGATIVE_INFINITY}).element}function O(t,l){if(!p.columns.find(o=>o.id===t))return{beforeId:null,afterId:null};const e=document.querySelector(`.cards[data-column-id="${c(t)}"]`);if(!e)return{beforeId:null,afterId:null};const a=[...e.querySelectorAll(".card")].map(o=>o.dataset.cardId),n=a.indexOf(l);return{afterId:n>0?a[n-1]:null,beforeId:n>=0&&n<a.length-1?a[n+1]:null}}function k(t,l,r,e){const a=L(t);if(!a)return;const n=p.columns.find(h=>h.id===l);if(!n)return;const o=e?n.cards.findIndex(h=>h.id===e):-1,d=r?n.cards.findIndex(h=>h.id===r):-1;let b=n.cards.length;o!==-1?b=o+1:d!==-1&&(b=d),n.cards.splice(b,0,{...a,column_id:l,optimistic:!0})}async function P(t,l){try{const r=await fetch(`${s}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:t,text:l})});if(!r.ok)throw new Error((await r.json()).error||"Create failed")}catch(r){g(`Create failed: ${r.message}`,!0)}}function _(t){if(t.board){p=S(t.board),m(),g("Synced");return}if(t.type==="label_created"){u.push(t.label),u.sort((e,a)=>e.name.localeCompare(a.name)),m();return}if(t.type==="label_updated"){const e=u.findIndex(a=>a.id===t.label.id);if(e!==-1){u[e]=t.label,u.sort((a,n)=>a.name.localeCompare(n.name));for(const a of p.columns)for(const n of a.cards)if(n.labels){const o=n.labels.findIndex(d=>d.id===t.label.id);o!==-1&&(n.labels[o]=t.label)}m()}return}if(t.type==="label_deleted"){u=u.filter(e=>e.id!==t.labelId),y.delete(t.labelId);for(const e of p.columns)for(const a of e.cards)a.labels&&(a.labels=a.labels.filter(n=>n.id!==t.labelId));m();return}if(t.type==="card_label_added"||t.type==="card_label_removed"){const e=$(t.cardId);e&&(e.card.labels=t.card.labels,m());return}if(!t.card)return;const l=t.card;L(l.id);const r=p.columns.find(e=>e.id===l.column_id||e.id===t.columnId);r&&(r.cards.push(l),r.cards.sort(A),m(),g("Synced"))}async function v(){const[t,l]=await Promise.all([fetch(`${s}/api/board`),fetch(`${s}/api/labels`)]);if(!t.ok||!l.ok)throw new Error("Could not load board or labels");p=S(await t.json()),u=await l.json(),m()}function D(){f==null||f.close(),f=new EventSource(`${s}/api/stream`),f.addEventListener("connected",()=>g("Live")),f.addEventListener("mutation",t=>{_(JSON.parse(t.data))}),f.onerror=()=>g("Reconnecting…",!0)}function g(t,l=!1){const r=document.querySelector("#status");r&&(r.textContent=t,r.classList.toggle("warn",l)),clearTimeout(w),l&&(w=setTimeout(()=>g((f==null?void 0:f.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function F(){I.innerHTML='<div class="loading">Loading board…</div>';try{await v(),D()}catch(t){I.innerHTML=`<div class="loading error">${c(t.message)}</div>`}}F();
