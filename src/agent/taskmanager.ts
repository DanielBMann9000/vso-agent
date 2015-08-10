// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

/// <reference path="./definitions/async.d.ts"/>
import cm = require('./common');
import ctxm = require('./context');
import ifm = require('./api/interfaces');
import async = require('async');
import fs = require('fs');
import path = require('path');
import shell = require('shelljs');
import webapi = require('./api/webapi');
import Q = require('q');

export class TaskManager {
    constructor(serviceContext: ctxm.ServiceContext, authHandler: ifm.IRequestHandler) {
        this.context = serviceContext;
        this.taskApi = webapi.TaskApi(serviceContext.config.settings.serverUrl, authHandler);
        this.taskFolder = path.resolve(serviceContext.workFolder, 'tasks');
    }

    public ensureTaskExists(task: ifm.TaskInstance): Q.IPromise<any> {
        if (!this.hasTask(task)) {
            return this.downloadTask(task);
        } else {
            return Q.resolve(null);
        }
    }

    public hasTask(task: ifm.TaskInstance) : boolean {
        if (fs.existsSync(this.getTaskPath(task))) {
            return true;
        } else {
            return false;
        }
    }

    public ensureTasksExist(tasks: ifm.TaskInstance[]): Q.IPromise<any> {
        // Check only once for each id/version combo
        var alreadyAdded = {};
        var uniqueTasks = [];

        for (var i = 0; i < tasks.length; i++) {
            var idVersion = tasks[i].id + ':' + tasks[i].version;
            if (!(idVersion in alreadyAdded)) {
                uniqueTasks.push(tasks[i]);
                alreadyAdded[idVersion] = true;
            }
        }
        
        var promises = tasks.map((task: ifm.TaskInstance) => {
            return this.ensureTaskExists(task);
        });
        
        return Q.all(promises);
    }

    public ensureLatestExist(): Q.IPromise<any> {
        var deferred = Q.defer();
        
        // Get all tasks
        this.taskApi.getTasks(null, (err, status, tasks) => {
            if (err) {
                deferred.reject(err);
            }

            // Sort out only latest versions
            var latestIndex = {};
            var latestTasks = [];
            for (var i = 0; i < tasks.length; i++) {
                var task = tasks[i];
                if (!(task.id in latestIndex)) {
                    // We haven't seen this task id before, add it to the array, 
                    // and track the "id":"array index" pair in the dictionary
                    latestTasks.push(this.getTaskInstance(task));
                    latestIndex[task.id] = latestTasks.length - 1;
                } else if (cm.versionStringFromTaskDef(task) > latestTasks[latestIndex[task.id]].version) {
                    // We've seen this task id before, but this task is a newer version, update the task in the array
                    latestTasks[latestIndex[task.id]] = this.getTaskInstance(task);
                }
            }

            // Call ensureTasksExist for those
            this.ensureTasksExist(latestTasks).then(() => {
                deferred.resolve(null);
            }, (err: any) => {
                deferred.reject(err);
            });
        });
        
        return deferred.promise;
    }

    private downloadTask(task: ifm.TaskInstance): Q.IPromise<any> {
        var deferred = Q.defer();
        var taskPath = this.getTaskPath(task);
        shell.mkdir('-p', taskPath);
        
        this.context.trace("Downloading task " + task.id + " v" + task.version + " to " + taskPath);
        this.taskApi.downloadTask(task.id, task.version, taskPath + '.zip', (err, statusCode) => {
            if (err) {
                deferred.reject(err);
            }

            cm.extractFile(taskPath + '.zip', taskPath, (err) => {
                if (err) {
                    shell.rm('-rf', taskPath);
                    deferred.reject(err);
                }

                shell.rm('-rf', taskPath + '.zip');
                deferred.resolve(null);
            });
        });
        
        return deferred.promise;
    }

    private getTaskPath(task: ifm.TaskInstance) : string {
        return path.resolve(this.taskFolder, task.name, task.version);
    }

    private getTaskInstance(task: ifm.TaskDefinition) : ifm.TaskInstance {
        return <ifm.TaskInstance>{'id':task.id, 'name': task.name, 'version': cm.versionStringFromTaskDef(task)}
    }

    private context: ctxm.ServiceContext;
    private taskApi: ifm.ITaskApi;
    private taskFolder: string;
}