(function(){const o=document.createElement("link").relList;if(o&&o.supports&&o.supports("modulepreload"))return;for(const e of document.querySelectorAll('link[rel="modulepreload"]'))n(e);new MutationObserver(e=>{for(const r of e)if(r.type==="childList")for(const l of r.addedNodes)l.tagName==="LINK"&&l.rel==="modulepreload"&&n(l)}).observe(document,{childList:!0,subtree:!0});function a(e){const r={};return e.integrity&&(r.integrity=e.integrity),e.referrerPolicy&&(r.referrerPolicy=e.referrerPolicy),e.crossOrigin==="use-credentials"?r.credentials="include":e.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function n(e){if(e.ep)return;e.ep=!0;const r=a(e);fetch(e.href,r)}})();const f="http://localhost:3001",w=document.querySelector("#app");let g={columns:[]},m=[],y=new Set,v=null,u=null,E=null;function d(t){return String(t).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function S(t){for(const o of g.columns){const a=o.cards.findIndex(n=>n.id===t);if(a!==-1)return{column:o,index:a,card:o.cards[a]}}return null}function x(t){let o=null;for(const a of g.columns){const n=a.cards.findIndex(e=>e.id===t);if(n!==-1){const[e]=a.cards.splice(n,1);o=e}}return o}function $(t){const o=new Set;return{columns:[...t.columns||[]].map(n=>({...n,cards:[...n.cards||[]].filter(e=>o.has(e.id)?!1:(o.add(e.id),!0)).sort(I)})).sort((n,e)=>Number(n.position)-Number(e.position)||n.id.localeCompare(e.id))}}function I(t,o){return Number(t.position)-Number(o.position)||String(t.created_at).localeCompare(String(o.created_at))||t.id.localeCompare(o.id)}function b(){var o;const t=(o=document.getElementById("labels-dialog"))==null?void 0:o.open;w.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="toolbar" style="padding: 1rem; background: #f0f0f0; display: flex; gap: 1rem; align-items: center;">
      <div class="filter-bar" style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <strong>Filter:</strong>
        ${m.map(a=>`
          <label style="display: flex; align-items: center; gap: 0.25rem; cursor: pointer;">
            <input type="checkbox" class="filter-checkbox" value="${d(a.id)}" ${y.has(a.id)?"checked":""}>
            <span class="label-chip" style="background-color: ${d(a.color)}; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; color: #fff; text-shadow: 0 0 2px #000;">${d(a.name)}</span>
          </label>
        `).join("")}
        ${y.size>0?'<button id="clear-filter" style="padding: 0.2rem 0.5rem;">Clear</button>':""}
      </div>
      <button id="manage-labels-btn" style="margin-left: auto; padding: 0.5rem 1rem;">Manage Labels</button>
    </div>
    <main class="board">
      ${g.columns.map(C).join("")}
    </main>
    <dialog id="labels-dialog" style="padding: 1rem; border-radius: 8px; border: 1px solid #ccc; max-width: 400px; width: 100%;">
      <form method="dialog">
        <h2 style="margin-top: 0;">Manage Labels</h2>
        <ul id="labels-list" style="list-style: none; padding: 0; margin: 1rem 0;">
          ${m.map(a=>`
            <li style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center;">
              <input type="color" value="${d(a.color)}" data-id="${d(a.id)}" class="edit-label-color">
              <input type="text" value="${d(a.name)}" data-id="${d(a.id)}" class="edit-label-name" style="flex: 1;">
              <button type="button" data-id="${d(a.id)}" class="delete-label-btn">Delete</button>
            </li>
          `).join("")}
        </ul>
        <h3 style="margin-bottom: 0.5rem;">Create Label</h3>
        <div class="create-label-form" style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
          <input type="color" id="new-label-color" value="#ff0000">
          <input type="text" id="new-label-name" placeholder="Label name" style="flex: 1;">
          <button type="button" id="create-label-btn">Create</button>
        </div>
        <div style="text-align: right;">
          <button type="submit">Close</button>
        </div>
      </form>
    </dialog>
  `,t&&document.getElementById("labels-dialog").showModal(),T()}function C(t){const o=t.cards.filter(a=>y.size===0?!0:a.labels&&a.labels.some(n=>y.has(n.id)));return`
    <section class="column" data-column-id="${d(t.id)}">
      <h2>${d(t.title)}</h2>
      <form class="add-card" data-column-id="${d(t.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${d(t.id)}">
        ${o.map(A).join("")}
      </div>
    </section>
  `}function A(t){const o=m.filter(a=>!(t.labels||[]).some(n=>n.id===a.id));return`
    <article class="card" draggable="true" data-card-id="${d(t.id)}" title="Drag to move">
      <div class="card-labels" style="display: flex; flex-wrap: wrap; gap: 0.25rem; margin-bottom: 0.5rem;">
        ${(t.labels||[]).map(a=>`
          <span class="label-chip" style="background-color: ${d(a.color)}; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; color: #fff; text-shadow: 0 0 2px #000; display: flex; align-items: center; gap: 0.25rem;" title="${d(a.name)}">
            ${d(a.name)}
            <button type="button" class="remove-label-btn" data-card-id="${d(t.id)}" data-label-id="${d(a.id)}" style="background: none; border: none; color: #fff; cursor: pointer; padding: 0; font-size: 1rem; line-height: 1;">&times;</button>
          </span>
        `).join("")}
      </div>
      <div class="card-text">${d(t.text)}</div>
      ${o.length>0?`
        <select class="assign-label-select" data-card-id="${d(t.id)}" style="margin-top: 0.5rem; width: 100%; font-size: 0.8rem; padding: 0.2rem;">
          <option value="">Add label...</option>
          ${o.map(a=>`<option value="${d(a.id)}">${d(a.name)}</option>`).join("")}
        </select>
      `:""}
    </article>
  `}function T(){document.querySelectorAll(".add-card").forEach(e=>{e.addEventListener("submit",async r=>{r.preventDefault();const l=e.elements.text,i=l.value.trim();i&&(l.value="",await q(e.dataset.columnId,i))})}),document.querySelectorAll(".card").forEach(e=>{e.addEventListener("dragstart",r=>{v=e.dataset.cardId,e.classList.add("dragging"),r.dataTransfer.effectAllowed="move",r.dataTransfer.setData("text/plain",v)}),e.addEventListener("dragend",()=>{e.classList.remove("dragging"),v=null,document.querySelectorAll(".drop-target").forEach(r=>r.classList.remove("drop-target"))})}),document.querySelectorAll(".cards").forEach(e=>{e.addEventListener("dragover",r=>{r.preventDefault(),e.classList.add("drop-target");const l=j(e,r.clientY),i=document.querySelector(".dragging");i&&(l==null?e.appendChild(i):e.insertBefore(i,l))}),e.addEventListener("dragleave",()=>e.classList.remove("drop-target")),e.addEventListener("drop",async r=>{r.preventDefault(),e.classList.remove("drop-target");const l=v||r.dataTransfer.getData("text/plain");if(!l)return;const i=e.dataset.columnId,{beforeId:s,afterId:c}=N(e,l);k(l,i,s,c);try{const p=await fetch(`${f}/api/cards/${encodeURIComponent(l)}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:i,beforeId:s,afterId:c})});if(!p.ok)throw new Error((await p.json()).error||"Move failed")}catch(p){h(`Move rejected: ${p.message}`,!0),await L()}})}),document.querySelectorAll(".filter-checkbox").forEach(e=>{e.addEventListener("change",r=>{r.target.checked?y.add(r.target.value):y.delete(r.target.value),b()})});const t=document.getElementById("clear-filter");t&&t.addEventListener("click",()=>{y.clear(),b()});const o=document.getElementById("manage-labels-btn"),a=document.getElementById("labels-dialog");o&&a&&o.addEventListener("click",()=>a.showModal());const n=document.getElementById("create-label-btn");n&&n.addEventListener("click",async()=>{const e=document.getElementById("new-label-name").value.trim(),r=document.getElementById("new-label-color").value;if(e)try{const l=await fetch(`${f}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:e,color:r})});if(!l.ok)throw new Error((await l.json()).error)}catch(l){alert(l.message)}}),document.querySelectorAll(".edit-label-name, .edit-label-color").forEach(e=>{e.addEventListener("change",async r=>{const l=r.target.dataset.id,i=r.target.closest("li"),s=i.querySelector(".edit-label-name").value.trim(),c=i.querySelector(".edit-label-color").value;if(s)try{const p=await fetch(`${f}/api/labels/${l}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:s,color:c})});if(!p.ok)throw new Error((await p.json()).error)}catch(p){alert(p.message)}})}),document.querySelectorAll(".delete-label-btn").forEach(e=>{e.addEventListener("click",async r=>{const l=r.target.dataset.id;try{const i=await fetch(`${f}/api/labels/${l}`,{method:"DELETE"});if(!i.ok)throw new Error((await i.json()).error)}catch(i){alert(i.message)}})}),document.querySelectorAll(".assign-label-select").forEach(e=>{e.addEventListener("change",async r=>{const l=r.target.value;if(!l)return;const i=r.target.dataset.cardId;try{const s=await fetch(`${f}/api/cards/${i}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:l})});if(!s.ok)throw new Error((await s.json()).error)}catch(s){alert(s.message)}})}),document.querySelectorAll(".remove-label-btn").forEach(e=>{e.addEventListener("click",async r=>{const l=r.target.dataset.cardId,i=r.target.dataset.labelId;try{const s=await fetch(`${f}/api/cards/${l}/labels/${i}`,{method:"DELETE"});if(!s.ok)throw new Error((await s.json()).error)}catch(s){alert(s.message)}})})}function j(t,o){return[...t.querySelectorAll(".card:not(.dragging)")].reduce((n,e)=>{const r=e.getBoundingClientRect(),l=o-r.top-r.height/2;return l<0&&l>n.offset?{offset:l,element:e}:n},{offset:Number.NEGATIVE_INFINITY,element:null}).element}function N(t,o){const a=[...t.querySelectorAll(".card")].map(e=>e.dataset.cardId),n=a.indexOf(o);return{afterId:n>0?a[n-1]:null,beforeId:n>=0&&n<a.length-1?a[n+1]:null}}function k(t,o,a,n){const e=x(t);if(!e)return;const r=g.columns.find(c=>c.id===o);if(!r)return;const l=n?r.cards.findIndex(c=>c.id===n):-1,i=a?r.cards.findIndex(c=>c.id===a):-1;let s=r.cards.length;l!==-1?s=l+1:i!==-1&&(s=i),r.cards.splice(s,0,{...e,column_id:o,optimistic:!0})}async function q(t,o){try{const a=await fetch(`${f}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:t,text:o})});if(!a.ok)throw new Error((await a.json()).error||"Create failed")}catch(a){h(`Create failed: ${a.message}`,!0)}}function O(t){if(t.type==="create_label"){m.push(t.label),m.sort((n,e)=>n.name.localeCompare(e.name)),b();return}if(t.type==="update_label"){const n=m.findIndex(e=>e.id===t.label.id);n!==-1&&(m[n]=t.label);for(const e of g.columns)for(const r of e.cards)if(r.labels){const l=r.labels.findIndex(i=>i.id===t.label.id);l!==-1&&(r.labels[l]=t.label)}b();return}if(t.type==="delete_label"){m=m.filter(n=>n.id!==t.labelId),y.delete(t.labelId);for(const n of g.columns)for(const e of n.cards)e.labels&&(e.labels=e.labels.filter(r=>r.id!==t.labelId));b();return}if(t.type==="assign_label"||t.type==="unassign_label"){const n=S(t.cardId);n&&t.card&&(n.card.labels=t.card.labels,b());return}if(t.board){g=$(t.board),b(),h("Synced");return}if(!t.card)return;const o=t.card;x(o.id);const a=g.columns.find(n=>n.id===o.column_id||n.id===t.columnId);a&&(a.cards.push(o),a.cards.sort(I),b(),h("Synced"))}async function B(){const t=await fetch(`${f}/api/labels`);if(!t.ok)throw new Error("Could not load labels");m=await t.json()}async function L(){const t=await fetch(`${f}/api/board`);if(!t.ok)throw new Error("Could not load board");g=$(await t.json())}function D(){u==null||u.close(),u=new EventSource(`${f}/api/stream`),u.addEventListener("connected",()=>h("Live")),u.addEventListener("mutation",t=>{O(JSON.parse(t.data))}),u.onerror=()=>h("Reconnecting…",!0)}function h(t,o=!1){const a=document.querySelector("#status");a&&(a.textContent=t,a.classList.toggle("warn",o)),clearTimeout(E),o&&(E=setTimeout(()=>h((u==null?void 0:u.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function M(){w.innerHTML='<div class="loading">Loading board…</div>';try{await Promise.all([B(),L()]),b(),D()}catch(t){w.innerHTML=`<div class="loading error">${d(t.message)}</div>`}}M();
