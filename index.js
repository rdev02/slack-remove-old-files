var async = require('async');
var fs = require('fs');
var path = require('path');
var request = require('request');

// FLAGS
var BACKUP_FLAG = '--backup';
var TOKEN_FLAG = '--token';
var BEFORE_FLAG = '--before';
var DELETE_FLAG = '--delete';

// DEFAULTS
var BACKUP_DEFAULT_LOC = './backup';
var date = new Date();
var DEFAULT_BEFORE = date.setTime(date.getTime() - 365 * 24 * 60 * 60 * 1000); // 1 year

// globals
var SLACK_LIST_URL = 'https://slack.com/api/files.list?token={token}&page={page}&ts_to={before}';
var SLACK_DELETE_URL = 'https://slack.com/api/files.delete';


var backupPath = _setupBackupPath();
var token = _readToken();
var beforeDate = _readBeforeDate();
var page = 1; var maxPages = 1;
var files = [];

async.whilst(_hasMoreFiles, _fetchMoreFiles, _backupAndRemove);

function _fetchMoreFiles(next) {
    var url = SLACK_LIST_URL
        .replace('{token}', token)
        .replace('{page}', page)
        .replace('{before}', beforeDate);

    console.log('fetching files: ' + url);
    request.get({ url: url }, function(err, httpResponse, body){
        if(err || !body){
            next(err, httpResponse);
            return;
        }

        var parsedObj = JSON.parse(body);
        if(!parsedObj.ok){
            next('response from Slack not ok: ' + (parsedObj ? parsedObj.error : 'null') );
            return;
        }

        maxPages = parsedObj.paging.pages;

        parsedObj.files.forEach(function(file){
            console.log('discovered [' + new Date(file.created * 1000).toString() + ']: ' + file.name);
            files.push({
                id: file.id,
                created: file.created,
                downloadLink: file.url_private_download,
                name: file.name
            });
        });

        page++;
        next();
    });
}

function _hasMoreFiles(){
    console.log(page + ' <= ' + maxPages);
    return page <= maxPages;
}

function _backupAndRemove(err){
    if(err){
        console.error(err);
        return;
    }

    console.log(files.length + ' about to be removed. supply --delete flag to actually remove.');
    var doDelete = process.argv.indexOf(DELETE_FLAG) >= 0;

    var backupFn = function(file, next){
        next();
    };

    if(backupPath){
        fs.mkdirSync(backupPath);

        console.log('applying backup folder: ' + backupPath);
        backupFn = function(file, next){
            var fileDate = new Date(file.created * 1000);
            var fileDateStr = fileDate.getFullYear() + '_' + fileDate.getMonth() + '_' + fileDate.getDay() + 
                '_' + fileDate.getHours() + '_' + fileDate.getMinutes() + '_' + fileDate.getSeconds();
            var fname = fileDateStr + '_' + file.name;
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
                        console.log('download complete:', fname);
                        next();
                    })
                    .on('err', (err) => {
                        console.log('download error:', fname);
                        console.error(err.stack);
                        next(err);
                    }));
        };
    } else {
        console.log("##### No backup selected! use --backup flag to backup before removing #####");
    }

    var deleteFn = backupFn;
    if(doDelete){
        deleteFn = function(file, next){
            console.log('removing ' + file.name + ' id[' + file.id + ']');
            request.post({
                url: SLACK_DELETE_URL,
                formData: {
                    token: token,
                    file: file.id
                }
            }, function(err, httpResponse, body){
                next(err);
            });
        };
    }

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
        function(err){
            if(err){
                console.error(err);
                return;
            }

            console.log(files.length + ' files processed.');
    });
}

function _setupBackupPath(){
    var backupPath = _getOptionValue(BACKUP_FLAG, BACKUP_DEFAULT_LOC);

    if(backupPath && fs.existsSync(backupPath)){
        throw backupPath + ' already exists. Please choose a different one';
    }

    console.log('--backup path configured: ' + backupPath);
    return backupPath;
}

function _readToken(){
    var token = _getOptionValue(TOKEN_FLAG);
    
    if(!token){
        throw 'please supply token with the --token option';
    }
    
    return token;
}

function _readBeforeDate(){
    var dateStr = _getOptionValue(BEFORE_FLAG);
    if(!dateStr){
        return DEFAULT_BEFORE / 1000;
    }

    console.log('--before time applied: ' + new Date(dateStr).toDateString());
    return new Date(dateStr).getTime() / 1000;
}

function _getOptionValue(flagName, defaultValue){
    var optionIdx = process.argv.indexOf(flagName);
    var result;
    if(optionIdx != -1){
        result = defaultValue;

        if(process.argv[optionIdx + 1] && !process.argv[optionIdx + 1].startsWith('-')){
            result = process.argv[optionIdx + 1];
        }
    }

    return result;
}