// @ts-check

/**
 * Send a JSON response.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 */
export function jsonResponse(res, status, data) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(status);
    res.end(JSON.stringify(data));
}

/**
 * Read the full request body as a string.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string>}
 */
export function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => resolve(body));
    });
}
