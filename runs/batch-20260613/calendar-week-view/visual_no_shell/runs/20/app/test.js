const fetch = require('node-fetch');

async function run() {
    const start = new Date();
    start.setHours(9, 0, 0, 0);
    const end = new Date();
    end.setHours(10, 30, 0, 0);

    await fetch('http://localhost:3000/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'Test Event 1',
            start_at: start.toISOString(),
            end_at: end.toISOString()
        })
    });

    const start2 = new Date();
    start2.setHours(10, 0, 0, 0);
    const end2 = new Date();
    end2.setHours(11, 0, 0, 0);

    await fetch('http://localhost:3000/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'Test Event 2',
            start_at: start2.toISOString(),
            end_at: end2.toISOString()
        })
    });

    const start3 = new Date();
    start3.setHours(9, 30, 0, 0);
    const end3 = new Date();
    end3.setHours(11, 30, 0, 0);

    await fetch('http://localhost:3000/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'Test Event 3',
            start_at: start3.toISOString(),
            end_at: end3.toISOString()
        })
    });
}

run();
