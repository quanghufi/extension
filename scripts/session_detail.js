import http from 'node:http';

function httpGet(path) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:3849${path}`, { timeout: 10000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Parse error: ${data.substring(0, 500)}`)); }
            });
        });
        req.on('error', reject);
    });
}

async function main() {
    const id = process.argv[2];
    const data = await httpGet(`/api/sessions/${id}`);
    console.log(JSON.stringify(data, null, 2));
}

main().catch(e => console.error(e.message));
