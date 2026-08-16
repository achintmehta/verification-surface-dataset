const fetch = require('node-fetch');

async function test() {
    const baseUrl = 'http://localhost:3001/api/logs';
    const res = await fetch(`${baseUrl}?limit=100&offset=50000&explain=true`);
    const data = await res.json();
    console.log(data);
}
test();