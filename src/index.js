'use strict';

const fs = require('mz/fs');
const path = require('path');
const http = require('http');

const config = require('config');
const less = require('less');
const request = require('request-promise');
const moment = require('moment');
const Handlebars = require('handlebars');
const Promise = require('bluebird');
const StaticServer = require('node-static').Server;

const SILENT = config.get('silent');
const INTERFACE = config.get('interface');
const PORT = config.get('port');
const UPDATE_INTERVAL = config.get('update_interval'); // in seconds
const OUT_DIR = path.join(__dirname, '..', 'output');
const blacklist = new Set(config.get('blacklist'));
const styleFile = path.join(__dirname, 'styles.less');
const templateFile = path.join(__dirname, 'template.html');
const outfile = path.join(OUT_DIR, 'index.html');

Handlebars.registerHelper('classify', text => text.replace(/\s+/, '-').toLowerCase());
Handlebars.registerHelper('fromNow', date => date.fromNow());
Handlebars.registerHelper('format', (date, format) => date.format(format));

function log_unless_silent(message) {
    if (!SILENT) {
        console.log(message);
    }
}

async function fetch_data_and_reschedule() {
    try {
        const data = await load_data();
        await generate_files(data);
    } catch (e) {
        console.error(e);
    }

    setTimeout(async function () {
        await fetch_data_and_reschedule();
    }, UPDATE_INTERVAL * 1000);
}

(async function () {
    await fetch_data_and_reschedule();
    await render_css();
    await serve();
})();

async function serve() {
    console.log('Starting static webserver');
    const static_server = new StaticServer(OUT_DIR);

    await Promise.fromCallback(cb => http.createServer(function (request, response) {
        request.addListener('end', () => static_server.serve(request, response)).resume();
    }).listen(PORT, INTERFACE, cb));

    console.log(`Webserver listening on ${INTERFACE}:${PORT}`);
    console.log(`Updating every ${UPDATE_INTERVAL} seconds`);
}

async function load_data() {
    log_unless_silent('Loading data');

    const monitors = await request({
        uri: 'https://app.datadoghq.com/api/v1/monitor',
        method: 'get',
        json: true,
        qs: {
            api_key: config.get('api_key'),
            application_key: config.get('application_key'),
            group_states: 'alert,warn'
        }
    });

    const single_alerts = monitors
        .filter(m => !blacklist.has(m.id))
        .filter(m => Object.keys(m.state.groups).length === 0)
        .map(m => ({ id: m.id, state: m.overall_state, name: m.name }));
    const multi_alerts = monitors
        .filter(m => !blacklist.has(m.id))
        .filter(m => Object.keys(m.state.groups).length > 0);

    const expanded = multi_alerts.reduce(function (result, monitor) {
        return result.concat(Object.values(monitor.state.groups).map(group => ({
            id: monitor.id,
            state: group.status,
            name: `${monitor.name} (${group.name})`
        })));
    }, []);

    return expanded.concat(single_alerts);
}

async function generate_files(monitors) {
    const template = await fs.readFile(templateFile);
    const tpl = Handlebars.compile(template.toString());

    log_unless_silent('Generating index.html');
    await fs.writeFile(outfile, tpl({
        lastUpdate: moment(),
        monitors,
        refresh: UPDATE_INTERVAL
    }));
}

async function render_css() {
    const source = await fs.readFile(styleFile);
    const result = await Promise.fromCallback(cb => less.render(source.toString(), cb));

    console.log('Generating styles.css');
    await fs.writeFile(path.join(__dirname, '..', 'output', 'styles.css'), result.css);
}
