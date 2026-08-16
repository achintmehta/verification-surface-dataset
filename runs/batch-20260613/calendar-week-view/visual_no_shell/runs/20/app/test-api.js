const fetch = require('node-fetch');

async function run() {
    const res = await fetch('http://localhost:3000/api/events?start=2020-01-01T00:00:00Z&end=2030-01-01T00:00:00Z');
    const data = await res.json();
    console.log(data);
}

run();
