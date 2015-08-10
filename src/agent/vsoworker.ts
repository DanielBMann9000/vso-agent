// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

/// <reference path="./definitions/node.d.ts"/>

import cfgm = require('./configuration');
import cm = require('./common');
import ctxm = require('./context');
import dm = require('./diagnostics');
import ifm = require('./api/interfaces');
import jrm = require('./job');
import fm = require('./feedback');
import os = require('os');
import tm = require('./tracing');
import path = require('path');
import crypto = require('crypto');
import wapim = require('./api/webapi');
import Q = require('q');

var serviceContext: ctxm.ServiceContext;
var trace: tm.Tracing;

function setVariables(job: ifm.JobRequestMessage, config: cm.IConfiguration) {
    trace.enter('setVariables');
    trace.state('variables', job.environment.variables);

    var workingFolder = cm.getWorkPath(config);
    var variables = job.environment.variables;

    var sys = variables[cm.sysVars.system];
    var collId = variables[cm.sysVars.collectionId];

    if (!variables[cm.sysVars.collectionUri]) {
        variables[cm.sysVars.collectionUri] =  job.environment.systemConnection ? job.environment.systemConnection.url : job.authorization.serverUrl;     
    }

    var defId = variables[cm.sysVars.definitionId];
    var hashInput = collId + ':' + defId;

    if (job.environment.endpoints) {
        job.environment.endpoints.forEach(function (endpoint) {
            hashInput = hashInput + ':' + endpoint.url;
        });
    }

    // TODO: build dir should be defined in the build plugin - not in core agent
    var hashProvider = crypto.createHash("sha256");
    hashProvider.update(hashInput, 'utf8');
    var hash = hashProvider.digest('hex');
    var buildDirectory = path.join(workingFolder, sys, hash);
    variables[cm.agentVars.workingDirectory] = workingFolder;
    variables[cm.agentVars.buildDirectory] = buildDirectory;

    var stagingFolder = path.join(buildDirectory, 'staging');
    job.environment.variables[cm.buildVars.stagingDirectory] = stagingFolder;

    trace.state('variables', job.environment.variables);
}

function deserializeEnumValues(job: ifm.JobRequestMessage) {
    if (job && job.environment && job.environment.mask) {
        job.environment.mask.forEach((maskHint: ifm.MaskHint, index: number) => {
            maskHint.type = ifm.TypeInfo.MaskType.enumValues[maskHint.type];
        });
    }
}

function getWorkerDiagnosticWriter(config: cm.IConfiguration): cm.IDiagnosticWriter {
    if (config.createDiagnosticWriter) {
        return config.createDiagnosticWriter();
    }
    
    var diagFolder = cm.getWorkerDiagPath(config);
    
    return dm.getDefaultDiagnosticWriter(config, diagFolder, 'worker');
}

//
// Worker process waits for a job message, processes and then exits
//
export function run(msg, consoleOutput: boolean, 
                    createFeedbackChannel: (agentUrl, taskUrl, jobInfo, ag) => cm.IFeedbackChannel): Q.Promise<any> {
    var deferred = Q.defer();
    var config: cm.IConfiguration = msg.config;
    
    serviceContext = new ctxm.ServiceContext(config, getWorkerDiagnosticWriter(config), true);
    trace = new tm.Tracing(__filename, serviceContext);
    trace.enter('.onMessage');
    trace.state('message', msg);

    serviceContext.info('worker::onMessage');
    if (msg.messageType === "job") {
        var job: ifm.JobRequestMessage = msg.data;
        deserializeEnumValues(job);
        setVariables(job, config);

        trace.write('Creating AuthHandler');
        var systemAuthHandler: ifm.IRequestHandler;
        if (job.environment.systemConnection) {
            trace.write('using session token');
            var accessToken = job.environment.systemConnection.authorization.parameters['AccessToken'];
            trace.state('AccessToken:', accessToken);
            systemAuthHandler = wapim.bearerHandler(accessToken);
        }
        else {
            trace.write('using altcreds');
            serviceContext.error('system connection token not supplied.  unsupported deployment.')
        }

        // TODO: jobInfo should go away and we should just have JobContext
        var jobInfo: cm.IJobInfo = cm.jobInfoFromJob(job, systemAuthHandler);

        // TODO: on output from context --> diag
        // TODO: these should be set beforePrepare and cleared postPrepare after we add agent ext
        if (msg.config && msg.config.creds) {
            process.env['altusername'] = msg.config.creds.username;
            process.env['altpassword'] = msg.config.creds.password;
        }

        serviceContext.status('Running job: ' + job.jobName);
        serviceContext.info('message:');
        trace.state('msg:', msg);

        var agentUrl = serviceContext.config.settings.serverUrl;
        var taskUrl = job.environment.variables[cm.sysVars.collectionUri]

        var serviceChannel: cm.IFeedbackChannel = createFeedbackChannel(agentUrl, taskUrl, jobInfo, serviceContext);

        var ctx: ctxm.JobContext = new ctxm.JobContext(job, systemAuthHandler, serviceChannel, serviceContext);
        trace.write('created JobContext');

        var jobRunner: jrm.JobRunner = new jrm.JobRunner(serviceContext, ctx);
        trace.write('created jobRunner');

        // guard to ensure we only "finish" once 
        var finishingJob: boolean = false;
        
        serviceChannel.on(fm.Events.JobAbandoned, () => {
            // if finishingJob is true here, then the jobRunner finished
            // ctx.finishJob will take care of draining the service channel
            if (!finishingJob) {
                finishingJob = true;
                serviceContext.error("Job abandoned by the server.");
                // nothing much to do if drain rejects...
                serviceChannel.drain().fin(() => {
                    trace.write("Service channel drained");
                    deferred.resolve(null);
                });
            }
        });

        jobRunner.run((err: any, result: ifm.TaskResult) => {
            trace.callback('job.run');

            serviceContext.status('Job Completed: ' + job.jobName);
            if (err) {
                serviceContext.error('Error: ' + err.message);
            }

            // if finishingJob is true here, then the lock renewer got a 404, which means the server abandoned the job
            // it's already calling serviceChannel.drain() and it's going to call finished()
            if (!finishingJob) {
                finishingJob = true;
                ctx.finishJob(result).fin(() => {
                    // trace and status no matter what. if finishJob failed, the fail handler below will be called
                    trace.callback('ctx.finishJob');
                    serviceContext.status('Job Finished: ' + job.jobName);
                }).fail((err: any) => {
                    if (err) {
                        serviceContext.error('Error: ' + err.message);
                    }
                }).fin(() => {
                    deferred.resolve(null);
                });
            }
        });
    }
    else {
        // don't know what to do with this message
        deferred.resolve(null);
    }
    
    return deferred.promise;
}

process.on('message', function (msg) {
    run(msg, true,
        function (agentUrl, taskUrl, jobInfo, ag) {
            return new fm.ServiceChannel(agentUrl, taskUrl, jobInfo, ag);
        }).fin(() => {
            process.exit();
        });
});

process.on('uncaughtException', function (err) {
    console.error('unhandled:' + err.message);
    console.error(err.stack);

    if (serviceContext) {
        serviceContext.error('worker unhandled: ' + err.message);
        serviceContext.error(err.stack);
    }

    process.exit();
});

process.on('SIGINT', function () {
    if (serviceContext) {
        serviceContext.info("\nShutting down agent.");
    }

    process.exit();
})
