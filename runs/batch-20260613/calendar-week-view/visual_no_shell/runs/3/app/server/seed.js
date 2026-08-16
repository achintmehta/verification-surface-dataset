/**
 * Seed script: POST test events to the running API server.
 * Run with: node server/seed.js
 */

const API = 'http://localhost:3001/api';

function getMonday() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayDate(dayOffset, h, m) {
  const d = getMonday();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const testEvents = [
  // Monday: single event (full width)
  { title: 'Morning Standup',  start_at: dayDate(0, 9, 0),   end_at: dayDate(0, 9, 30)  },

  // Monday: two overlapping events (side by side, each 50% width)
  { title: 'Design Review',    start_at: dayDate(0, 10, 0),  end_at: dayDate(0, 11, 30) },
  { title: 'Sprint Planning',  start_at: dayDate(0, 10, 30), end_at: dayDate(0, 12, 0)  },

  // Monday: three simultaneous events (equal thirds)
  { title: 'Event A',          start_at: dayDate(0, 14, 0),  end_at: dayDate(0, 15, 0)  },
  { title: 'Event B',          start_at: dayDate(0, 14, 0),  end_at: dayDate(0, 15, 0)  },
  { title: 'Event C',          start_at: dayDate(0, 14, 0),  end_at: dayDate(0, 15, 0)  },

  // Monday: event after cluster ends (should be full width)
  { title: 'Afternoon Solo',   start_at: dayDate(0, 16, 0),  end_at: dayDate(0, 17, 0)  },

  // Tuesday: chain overlap (09:00-11:00, 10:00-12:00, 11:30-13:00)
  { title: 'Chain A (9-11)',   start_at: dayDate(1, 9, 0),   end_at: dayDate(1, 11, 0)  },
  { title: 'Chain B (10-12)',  start_at: dayDate(1, 10, 0),  end_at: dayDate(1, 12, 0)  },
  { title: 'Chain C (11:30-13)',start_at: dayDate(1, 11, 30),end_at: dayDate(1, 13, 0)  },

  // Wednesday: event ending at midnight (24:00)
  { title: 'Late Night Work',  start_at: dayDate(2, 22, 0),  end_at: dayDate(3, 0, 0)   },

  // Wednesday: normal event earlier
  { title: 'Lunch Meeting',    start_at: dayDate(2, 12, 0),  end_at: dayDate(2, 13, 0)  },

  // Thursday: long event
  { title: 'All Day Workshop', start_at: dayDate(3, 8, 0),   end_at: dayDate(3, 18, 0)  },

  // Friday: two non-overlapping events (each full width)
  { title: 'Morning Call',     start_at: dayDate(4, 9, 0),   end_at: dayDate(4, 10, 0)  },
  { title: 'Afternoon Call',   start_at: dayDate(4, 14, 0),  end_at: dayDate(4, 15, 0)  },
];

async function seed() {
  console.log('Seeding test events...\n');
  for (const ev of testEvents) {
    try {
      const res = await fetch(`${API}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev),
      });
      const data = await res.json();
      if (res.ok) {
        console.log(`✓ Created id=${data.id}: "${ev.title}"`);
      } else {
        console.error(`✗ Failed "${ev.title}": ${data.error}`);
      }
    } catch (err) {
      console.error(`✗ Error "${ev.title}": ${err.message}`);
    }
  }
  console.log('\nDone!');
}

seed();
