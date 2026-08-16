async function run() {
  let beforeId = 'bc79249e-f56a-45ab-936f-870021340fe4';
  let afterId = '71f6dba2-1b0c-400d-a74a-421ac0efd351';
  let moveId = 'cf532bb1-26e6-49a3-aa5b-f2ba960ee5ca';
  
  for (let i = 0; i < 20; i++) {
    const res = await fetch('http://localhost:3000/api/cards/' + moveId + '/move', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        columnId: '4a34b423-4a23-44c5-8dd6-14b30a47ed72',
        beforeId,
        afterId
      })
    });
    const data = await res.json();
    console.log(data.position);
    
    const temp = moveId;
    moveId = beforeId;
    beforeId = temp;
  }
}
run();
