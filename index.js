const async = require('async');
const fs = require('fs');
const path = require('path');
const request = require('request');

// FLAGS
const BACKUP_FLAG = '--backup';
const TOKEN_FLAG =  '--token';
const BEFORE_FLAG = '--before';
const DELETE_FLAG = '--delete';

// DEFAULTS
let BACKUP_DEFAULT_LOC = './backup';
let date = new Date();
const DEFAULT_BEFORE = date.setTime(date.getTime() - 365 * 24 * 60 * 60 * 1000); // 1 year

// globals
const SLACK_LIST_URL = 'https://slack.com/api/files.list?token={token}&page={page}&ts_to={before}';
const SLACK_DELETE_URL = 'https://slack.com/api/files.delete';

const _fetchMoreFiles = (next) => {
    const url = SLACK_LIST_URL
        .replace('{token}', token)
        .replace('{page}', page)
        .replace('{before}', beforeDate);

    console.log('fetching files: ' + url);
    request.get({ url: url }, (err, httpResponse, body) => {
        if(err || !body){
            next(err, httpResponse);
            return;
        }

        const parsedObj = JSON.parse(body);
        if(!parsedObj.ok){
            next('response from Slack not ok: ' + (parsedObj ? parsedObj.error : 'null') );
            return;
        }

        maxPages = parsedObj.paging.pages;

        parsedObj.files.forEach((file) => {
            console.log('discovered [%s]: %s', new Date(file.created * 1000).toString(), file.name);
            if(file.url_private_download || file.url_private){
                files.push({
                    id: file.id,
                    created: file.created,
                    downloadLink: file.url_private_download || file.url_private,
                    name: file.name
                });
            } else {
                console.warn('WARN: %s will be skipped because no download link is present', file.name);
            }
        });

        page++;
        next();
    });
}

const _hasMoreFiles = () => {
    console.log(page + ' <= ' + maxPages);
    return page <= maxPages;
}

const _backupAndRemove = (err) => {
    if(err){
        console.error(err);
        return;
    }

    console.log('%d about to be removed. supply --delete flag to actually remove.', files.length);
    const doDelete = process.argv.indexOf(DELETE_FLAG) >= 0;

    let backupFn = (file, next) => {
        next();
    };

    if(backupPath){
        fs.mkdirSync(backupPath);

        console.log('applying backup folder: %s', backupPath);
        backupFn = (file, next) => {
            const fileDate = new Date(file.created * 1000);
            const fileDateStr = fileDate.getFullYear() + '_' + fileDate.getMonth() + '_' + fileDate.getDay() + 
                '_' + fileDate.getHours() + '_' + fileDate.getMinutes() + '_' + fileDate.getSeconds();
            // trim file name to 200 chars to avoid ENAMETOOLONG
            const fname = fileDateStr + '_' + file.name.substring(0, file.name.length > 200 ? 200 : file.name.length);
            console.log('backing up ' + fname);
            request
                .get(file.downloadLink,{
                        'auth': {
                            'bearer': token
                        }
                    })
                .on('error', function(err) {
                    console.log(err)
                })
                .pipe(fs.createWriteStream(backupPath + path.sep + fname)
                    .on('finish', () => {
                        console.log('download complete: %s', fname);
                        next();
                    })
                    .on('err', (err) => {
                        console.error('download error: %s', fname);
                        console.error(err.stack);
                        next(err);
                    }));
        };
    } else {
        console.log("##### No backup selected! use --backup flag to backup before removing #####");
    }

    let deleteFn = (file, next) => {
        next();
    };

    if(doDelete){
        deleteFn = (file, next) => {
            console.log('removing %s id[%s]', file.name, file.id);
            request.post({
                url: SLACK_DELETE_URL,
                formData: {
                    token: token,
                    file: file.id
                }
            }, (err, httpResponse, body) => {
                if(httpResponse.statusCode === 429){
                    console.log('%s was not deleted', file.id);
                    waitTime = httpResponse.headers['retry-after'];
                    return next(httpResponse.statusCode);
                }
                file.deleted = true;
                console.log('id %s delete status: %s', file.id, httpResponse.statusCode)
                next(err);
            });
        };
    }

    const filesContainer = { files: files };

    async.whilst(
        () => {
            console.log("Having %d file to delete", filesContainer.files.length );
            return filesContainer.files.length > 0;
        },
        (whNext) => {
            async.eachLimit(files, 15, 
                function(file, next){
                    async.waterfall([
                        function(cbNext){
                            backupFn(file, cbNext);
                        },
                        function(cbNext){
                            deleteFn(file, cbNext);
                        }
                    ],function(err, res){
                        next(err);
                    });
                }, 
                async function(err){
                    if(err){
                        if(err == 429){
                            console.log("Too many requests caught. waiting. %d seconds..", waitTime * 10);
                            filesContainer.files = files.filter(f => !f.deleted);
                            await new Promise(resolve => setTimeout(resolve, waitTime * 10));
                            return whNext();
                        }
                        console.error(err);
                        return;
                    }
                    whNext(err);
            });
        },
        () => {
            console.log('%d files processed.', files.length - filesContainer.files.length);
        });
}

const _setupBackupPath = () => {
    let backupPath = _getOptionValue(BACKUP_FLAG, BACKUP_DEFAULT_LOC);

    if(backupPath && fs.existsSync(backupPath)){
        throw backupPath + ' already exists. Please choose a different one';
    }

    console.log('--backup path configured: %s', backupPath);
    return backupPath;
}

const _readToken = () => {
    var token = _getOptionValue(TOKEN_FLAG);
    
    if(!token){
        throw 'please supply token with the --token option';
    }
    
    return token;
}

const _readBeforeDate = () => {
    const dateStr = _getOptionValue(BEFORE_FLAG);
    if(!dateStr){
        return DEFAULT_BEFORE / 1000;
    }

    console.log('--before time applied: ' + new Date(dateStr).toDateString());
    return new Date(dateStr).getTime() / 1000;
}

const _getOptionValue = (flagName, defaultValue) => {
    const optionIdx = process.argv.indexOf(flagName);
    let result;
    if(optionIdx != -1){
        result = defaultValue;

        if(process.argv[optionIdx + 1] && !process.argv[optionIdx + 1].startsWith('-')){
            result = process.argv[optionIdx + 1];
        }
    }

    return result;
}

// ====================================================================================
let backupPath = _setupBackupPath();
let token = _readToken();
let beforeDate = _readBeforeDate();
let page = 1, maxPages = 1;
let files = [];
let waitTime = 10; //seconds

// main loop
async.whilst(_hasMoreFiles, _fetchMoreFiles, _backupAndRemove);