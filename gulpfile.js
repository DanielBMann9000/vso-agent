var fs = require('fs');
var path = require('path');
var gulp = require('gulp');
var del = require('del');
var mocha = require('gulp-mocha');
var runSequence = require('run-sequence');
var ts = require('gulp-typescript');
var merge = require('merge2');

var buildRoot = path.join(__dirname, '_build');
var tarRoot = path.join(__dirname, '_tar');
var packageRoot = path.join(__dirname, '_package');
var testRoot = path.join(__dirname, '_test');
var testPath = path.join(testRoot, 'test');
var buildPath = path.join(buildRoot, 'vsoxplat');
var packagePath = path.join(packageRoot, 'vsoxplat');
var binPath = path.join(buildPath, 'bin');
var agentPath = path.join(buildPath, 'agent');
var handlerPath = path.join(agentPath, 'handlers');
var pluginPath = path.join(agentPath, 'plugins');
var buildPluginPath = path.join(pluginPath, 'build');
var buildPluginLibPath = path.join(buildPluginPath, 'lib');


var writeHeader = function(title) {
	console.log();
	console.log('********** ' + title + ' **********');
}

var tsProject = ts.createProject({
	declartionFiles:false,
	noExternalResolve: true,
	module: 'commonjs'
});

gulp.task('build', function () { 
	writeHeader('build');
	var tsResult = gulp.src(['src/**/*.ts'])
		.pipe(ts(tsProject), null, ts.reporter.fullReporter(true));
		
	var packageJson = gulp.src(['package.json']);
	var svcSh = gulp.src(['src/agent/svc.sh']);
	var pyHandler = gulp.src(['src/agent/handlers/vso.py']);
	var askPass = gulp.src(['src/agent/plugins/build/lib/askpass.js']);
	var installJs = gulp.src(['src/bin/install.js']);
	
	return merge([
		tsResult.js.pipe(gulp.dest(buildPath)),
		packageJson.pipe(gulp.dest(path.join(buildPath, 'agent'))),
		svcSh.pipe(gulp.dest(agentPath)),
		pyHandler.pipe(gulp.dest(handlerPath)),
		askPass.pipe(gulp.dest(buildPluginLibPath)),
		installJs.pipe(gulp.dest(binPath))
	]);
});

gulp.task('testprep', function () {
	writeHeader('test');
	
	var buildSrc = gulp.src([path.join(buildPath, '**')]);
	var testSrcPaths = ['src/test/messages/**',
						'src/test/projects/**',
						'src/test/tasks/**', 
						'!src/test/definitions'];
	
	return merge([
		buildSrc.pipe(gulp.dest(testRoot)),
		gulp.src(testSrcPaths, { base: 'src/test' })
			.pipe(gulp.dest(testPath))
	]);
});

gulp.task('test', function () {
	return gulp.src([path.join(testPath, '*.js')])
		.pipe(mocha({ reporter: 'spec', ui: 'bdd' }));
});

gulp.task('package', function () {
	writeHeader('package')
	return gulp.src([path.join(buildPath, '**'), 'README.md'])
		.pipe(gulp.dest(packagePath));
});

gulp.task('clean', function (cb) {
	writeHeader("cleaning outputs");
	del([buildRoot, tarRoot, packageRoot, testRoot],cb);
});

gulp.task('default', function(done) {
    runSequence('clean', 
    		    'build', 
    		    'package',
				done);
});
