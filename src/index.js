'use strict';

const fs = require('mz/fs');
const path = require('path');
const http = require('http');

const config = require('config');
const co = require('co');
const less = require('less');
const request = require('request-promise');
const moment = require('moment');
const Handlebars = require('handlebars');
const Promise = require('bluebird');
const staticSrv = require('node-static');

const UPDATE_INTERVAL = config.get('update_interval'); // in seconds
const OUT_DIR = path.join(__dirname, '..', 'output');
const blacklist = new Set(config.get('blacklist'));
const styleFile = path.join(__dirname, 'styles.less');
const templateFile = path.join(__dirname, 'template.html');
const outfile = path.join(OUT_DIR, 'index.html');

Handlebars.registerHelper('classify', text => text.replace(/\s+/, '-').toLowerCase());
Handlebars.registerHelper('fromNow', date => date.fromNow());
Handlebars.registerHelper('format', (date, format) => date.format(format));

function* fetchDataAndReschedule() {
    try {
        const data = yield loadData();
        yield generateFiles(data);
    } catch (e) {
        console.error(e);
    }

    setTimeout(() => co(fetchDataAndReschedule), UPDATE_INTERVAL * 1000);
}


co(function* () {
    yield fetchDataAndReschedule();
    yield renderCss();
    yield serve();
});

function* serve() {
    console.log('Starting static webserver');
    const file = new staticSrv.Server(OUT_DIR);

    yield Promise.fromCallback(cb => http.createServer(function (request, response) {
        request.addListener('end', () => file.serve(request, response)).resume();
    }).listen(8080, cb));

    console.log('Webserver listening on port 8080');
}

function* loadData() {
    console.log('Loading data');

    const monitors = yield request({
        uri: 'https://app.datadoghq.com/api/v1/monitor',
        method: 'get',
        json: true,
        qs: {
            api_key: config.get('api_key'),
            application_key: config.get('application_key')
        }
    });

    return monitors.filter(monitor => !blacklist.has(monitor.id));
}

function* generateFiles(monitors) {
    const template = yield fs.readFile(templateFile);
    const tpl = Handlebars.compile(template.toString());

    console.log('Generating index.html');
    yield fs.writeFile(outfile, tpl({
        lastUpdate: moment(),
        monitors,
        refresh: UPDATE_INTERVAL
    }));
}

function* renderCss() {
    const source = yield fs.readFile(styleFile);
    const result = yield Promise.fromCallback(cb => less.render(source.toString(), cb));

    console.log('Generating styles.css');
    yield fs.writeFile(path.join(__dirname, '..', 'output', 'styles.css'), result.css);
}
