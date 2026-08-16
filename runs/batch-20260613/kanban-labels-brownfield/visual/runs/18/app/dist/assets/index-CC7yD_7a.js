(function(){const n=document.createElement("link").relList;if(n&&n.supports&&n.supports("modulepreload"))return;for(const a of document.querySelectorAll('link[rel="modulepreload"]'))t(a);new MutationObserver(a=>{for(const r of a)if(r.type==="childList")for(const o of r.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&t(o)}).observe(document,{childList:!0,subtree:!0});function l(a){const r={};return a.integrity&&(r.integrity=a.integrity),a.referrerPolicy&&(r.referrerPolicy=a.referrerPolicy),a.crossOrigin==="use-credentials"?r.credentials="include":a.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function t(a){if(a.ep)return;a.ep=!0;const r=l(a);fetch(a.href,r)}})();const s="http://localhost:3001",w=document.querySelector("#app");let b={columns:[]},u=[],g=new Set,v=null,p=null,E=null;function d(e){return String(e).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}function $(e){let n=null;for(const l of b.columns){const t=l.cards.findIndex(a=>a.id===e);if(t!==-1){const[a]=l.cards.splice(t,1);n=a}}return n}function y(e){const n=new Set;return{columns:[...e.columns||[]].map(t=>({...t,cards:[...t.cards||[]].filter(a=>n.has(a.id)?!1:(n.add(a.id),!0)).sort(I)})).sort((t,a)=>Number(t.position)-Number(a.position)||t.id.localeCompare(a.id))}}function I(e,n){return Number(e.position)-Number(n.position)||String(e.created_at).localeCompare(String(n.created_at))||e.id.localeCompare(n.id)}function m(){w.innerHTML=`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="toolbar">
      <div class="filter-bar">
        <strong>Filter:</strong>
        ${u.map(e=>`
          <label class="filter-label">
            <input type="checkbox" value="${d(e.id)}" ${g.has(e.id)?"checked":""}>
            <span class="chip" style="background-color: ${d(e.color)}">${d(e.name)}</span>
          </label>
        `).join("")}
        ${g.size>0?'<button id="clear-filter">Clear</button>':""}
      </div>
      <button id="manage-labels-btn">Manage Labels</button>
    </div>
    <main class="board">
      ${b.columns.map(S).join("")}
    </main>
    <dialog id="label-manager-dialog">
      <form method="dialog">
        <h2>Manage Labels</h2>
        <ul id="label-list">
          ${u.map(e=>`
            <li>
              <input type="color" value="${d(e.color)}" data-id="${d(e.id)}" class="edit-label-color">
              <input type="text" value="${d(e.name)}" data-id="${d(e.id)}" class="edit-label-name">
              <button type="button" data-id="${d(e.id)}" class="delete-label-btn">Delete</button>
            </li>
          `).join("")}
        </ul>
        <div class="add-label-form">
          <input type="color" id="new-label-color" value="#ff0000">
          <input type="text" id="new-label-name" placeholder="New label name">
          <button type="button" id="add-label-btn">Add</button>
        </div>
        <button type="submit">Close</button>
      </form>
    </dialog>
  `,A()}function S(e){return`
    <section class="column" data-column-id="${d(e.id)}">
      <h2>${d(e.title)}</h2>
      <form class="add-card" data-column-id="${d(e.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${d(e.id)}">
        ${e.cards.map(C).join("")}
      </div>
    </section>
  `}function C(e){if(g.size>0){const n=new Set((e.labels||[]).map(t=>t.id));let l=!1;for(const t of g)if(n.has(t)){l=!0;break}if(!l)return""}return`
    <article class="card" draggable="true" data-card-id="${d(e.id)}" title="Drag to move">
      <div class="card-labels">
        ${(e.labels||[]).map(n=>`
          <span class="chip" style="background-color: ${d(n.color)}">
            ${d(n.name)}
            <button type="button" class="remove-label-btn" data-card-id="${d(e.id)}" data-label-id="${d(n.id)}">&times;</button>
          </span>
        `).join("")}
        <div class="assign-label-dropdown">
          <button type="button" class="assign-label-btn">+</button>
          <div class="dropdown-content">
            ${u.filter(n=>!(e.labels||[]).some(l=>l.id===n.id)).map(n=>`
              <button type="button" class="assign-specific-label-btn" data-card-id="${d(e.id)}" data-label-id="${d(n.id)}">
                <span class="chip" style="background-color: ${d(n.color)}">${d(n.name)}</span>
              </button>
            `).join("")}
          </div>
        </div>
      </div>
      <div class="card-text">${d(e.text)}</div>
    </article>
  `}function A(){var l;document.querySelectorAll(".filter-label input").forEach(t=>{t.addEventListener("change",a=>{a.target.checked?g.add(a.target.value):g.delete(a.target.value),m()})});const e=document.getElementById("clear-filter");e&&e.addEventListener("click",()=>{g.clear(),m()});const n=document.getElementById("manage-labels-btn");n&&n.addEventListener("click",()=>{document.getElementById("label-manager-dialog").showModal()}),(l=document.getElementById("add-label-btn"))==null||l.addEventListener("click",async()=>{const t=document.getElementById("new-label-name"),a=document.getElementById("new-label-color"),r=t.value.trim(),o=a.value;if(r)try{const i=await fetch(`${s}/api/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:r,color:o})});if(!i.ok)throw new Error((await i.json()).error);t.value=""}catch(i){alert(i.message)}}),document.querySelectorAll(".edit-label-name").forEach(t=>{t.addEventListener("change",async a=>{const r=a.target.dataset.id,o=a.target.value.trim(),f=document.querySelector(`.edit-label-color[data-id="${r}"]`).value;if(o)try{const c=await fetch(`${s}/api/labels/${r}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:o,color:f})});if(!c.ok)throw new Error((await c.json()).error)}catch(c){alert(c.message)}})}),document.querySelectorAll(".edit-label-color").forEach(t=>{t.addEventListener("change",async a=>{const r=a.target.dataset.id,o=a.target.value,f=document.querySelector(`.edit-label-name[data-id="${r}"]`).value.trim();try{const c=await fetch(`${s}/api/labels/${r}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:f,color:o})});if(!c.ok)throw new Error((await c.json()).error)}catch(c){alert(c.message)}})}),document.querySelectorAll(".delete-label-btn").forEach(t=>{t.addEventListener("click",async a=>{const r=a.target.dataset.id;try{const o=await fetch(`${s}/api/labels/${r}`,{method:"DELETE"});if(!o.ok)throw new Error((await o.json()).error)}catch(o){alert(o.message)}})}),document.querySelectorAll(".remove-label-btn").forEach(t=>{t.addEventListener("click",async a=>{const r=a.target.dataset.cardId,o=a.target.dataset.labelId;try{const i=await fetch(`${s}/api/cards/${r}/labels/${o}`,{method:"DELETE"});if(!i.ok)throw new Error((await i.json()).error)}catch(i){alert(i.message)}})}),document.querySelectorAll(".assign-specific-label-btn").forEach(t=>{t.addEventListener("click",async a=>{const r=a.currentTarget.dataset.cardId,o=a.currentTarget.dataset.labelId;try{const i=await fetch(`${s}/api/cards/${r}/labels`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({labelId:o})});if(!i.ok)throw new Error((await i.json()).error)}catch(i){alert(i.message)}})}),document.querySelectorAll(".add-card").forEach(t=>{t.addEventListener("submit",async a=>{a.preventDefault();const r=t.elements.text,o=r.value.trim();o&&(r.value="",await N(t.dataset.columnId,o))})}),document.querySelectorAll(".card").forEach(t=>{t.addEventListener("dragstart",a=>{v=t.dataset.cardId,t.classList.add("dragging"),a.dataTransfer.effectAllowed="move",a.dataTransfer.setData("text/plain",v)}),t.addEventListener("dragend",()=>{t.classList.remove("dragging"),v=null,document.querySelectorAll(".drop-target").forEach(a=>a.classList.remove("drop-target"))})}),document.querySelectorAll(".cards").forEach(t=>{t.addEventListener("dragover",a=>{a.preventDefault(),t.classList.add("drop-target");const r=T(t,a.clientY),o=document.querySelector(".dragging");o&&(r==null?t.appendChild(o):t.insertBefore(o,r))}),t.addEventListener("dragleave",()=>t.classList.remove("drop-target")),t.addEventListener("drop",async a=>{a.preventDefault(),t.classList.remove("drop-target");const r=v||a.dataTransfer.getData("text/plain");if(!r)return;const o=t.dataset.columnId,{beforeId:i,afterId:f}=x(t,r);j(r,o,i,f);try{const c=await fetch(`${s}/api/cards/${encodeURIComponent(r)}/move`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:o,beforeId:i,afterId:f})});if(!c.ok)throw new Error((await c.json()).error||"Move failed")}catch(c){h(`Move rejected: ${c.message}`,!0),await L()}})})}function T(e,n){return[...e.querySelectorAll(".card:not(.dragging)")].reduce((t,a)=>{const r=a.getBoundingClientRect(),o=n-r.top-r.height/2;return o<0&&o>t.offset?{offset:o,element:a}:t},{offset:Number.NEGATIVE_INFINITY,element:null}).element}function x(e,n){const l=[...e.querySelectorAll(".card")].map(a=>a.dataset.cardId),t=l.indexOf(n);return{afterId:t>0?l[t-1]:null,beforeId:t>=0&&t<l.length-1?l[t+1]:null}}function j(e,n,l,t){const a=$(e);if(!a)return;const r=b.columns.find(c=>c.id===n);if(!r)return;const o=t?r.cards.findIndex(c=>c.id===t):-1,i=l?r.cards.findIndex(c=>c.id===l):-1;let f=r.cards.length;o!==-1?f=o+1:i!==-1&&(f=i),r.cards.splice(f,0,{...a,column_id:n,optimistic:!0})}async function N(e,n){try{const l=await fetch(`${s}/api/cards`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({columnId:e,text:n})});if(!l.ok)throw new Error((await l.json()).error||"Create failed")}catch(l){h(`Create failed: ${l.message}`,!0)}}function q(e){if(e.type==="create_label"){u.push(e.label),u.sort((t,a)=>t.name.localeCompare(a.name)),m();return}if(e.type==="update_label"){const t=u.findIndex(a=>a.id===e.label.id);t!==-1&&(u[t]=e.label,u.sort((a,r)=>a.name.localeCompare(r.name))),e.board&&(b=y(e.board)),m();return}if(e.type==="delete_label"){u=u.filter(t=>t.id!==e.labelId),g.delete(e.labelId),e.board&&(b=y(e.board)),m();return}if(e.type==="assign_label"||e.type==="unassign_label"){e.board&&(b=y(e.board)),m();return}if(e.board){b=y(e.board),m(),h("Synced");return}if(!e.card)return;const n=e.card;$(n.id);const l=b.columns.find(t=>t.id===n.column_id||t.id===e.columnId);l&&(l.cards.push(n),l.cards.sort(I),m(),h("Synced"))}async function L(){const e=await fetch(`${s}/api/board`);if(!e.ok)throw new Error("Could not load board");b=y(await e.json()),m()}function k(){p==null||p.close(),p=new EventSource(`${s}/api/stream`),p.addEventListener("connected",()=>h("Live")),p.addEventListener("mutation",e=>{q(JSON.parse(e.data))}),p.onerror=()=>h("Reconnecting…",!0)}function h(e,n=!1){const l=document.querySelector("#status");l&&(l.textContent=e,l.classList.toggle("warn",n)),clearTimeout(E),n&&(E=setTimeout(()=>h((p==null?void 0:p.readyState)===EventSource.OPEN?"Live":"Reconnecting…"),4e3))}async function O(){const e=await fetch(`${s}/api/labels`);if(!e.ok)throw new Error("Could not load labels");u=await e.json()}async function B(){w.innerHTML='<div class="loading">Loading board…</div>';try{await Promise.all([L(),O()]),k()}catch(e){w.innerHTML=`<div class="loading error">${d(e.message)}</div>`}}B();
