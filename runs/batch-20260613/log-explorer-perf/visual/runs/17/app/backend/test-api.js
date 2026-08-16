const fetch = require('node-fetch');

async function test() {
    const baseUrl = 'http://localhost:3001/api/logs';
    
    async function measure(url) {
        const start = Date.now();
        const res = await fetch(url);
        await res.json();
        return Date.now() - start;
    }

    console.log('Warming up...');
    await measure(`${baseUrl}?limit=100&offset=0`);

    const tests = [
        { name: 'offset 0', url: `${baseUrl}?limit=100&offset=0` },
        { name: 'offset 50000', url: `${baseUrl}?limit=100&offset=50000` },
        { name: 'offset 99900', url: `${baseUrl}?limit=100&offset=99900` },
        { name: 'severity offset 50000', url: `${baseUrl}?limit=100&offset=50000&severity=info` },
        { name: 'selective substring offset 0', url: `${baseUrl}?limit=100&offset=0&q=9999` },
        { name: 'non-selective substring offset 50000', url: `${baseUrl}?limit=100&offset=50000&q=message` },
    ];

    for (const t of tests) {
        let times = [];
        for (let i = 0; i < 20; i++) {
            times.push(await measure(t.url));
        }
        times.sort((a, b) => a - b);
        console.log(`${t.name}: p95 ~ ${times[Math.floor(times.length * 0.95)]}ms (times: ${times.join(', ')})`);
    }
}

test();