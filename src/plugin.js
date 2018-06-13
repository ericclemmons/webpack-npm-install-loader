var MemoryFS = require("memory-fs");
var webpack = require("webpack");
var path = require('path')

var installer = require("./installer");
var utils = require("./utils");

var depFromErr = function(err) {
  if (!err) {
    return undefined;
  }

  /**
   * Supported package formats:
   * - path
   * - react-lite
   * - @cycle/core
   * - bootswatch/lumen/bootstrap.css
   * - lodash.random
   */
  var matches = /(?:(?:Cannot resolve module)|(?:Can't resolve)) '([@\w\/\.-]+)' in/.exec(err);

  if (!matches) {
    return undefined;
  }

  return matches[1];
}

function NpmInstallPlugin(options) {
  this.preCompiler = null;
  this.compiler = null;
  this.options = Object.assign(installer.defaultOptions, options);
  this.resolving = {};

  installer.checkBabel();
}

NpmInstallPlugin.prototype.apply = function(compiler) {
  this.compiler = compiler;

  // Recursively install missing dependencies so primary build doesn't fail
  compiler.hooks.watchRun.tapAsync('npm-install-plugin', this.preCompile.bind(this));

  // Install externals that wouldn't normally be resolved
  if (Array.isArray(compiler.options.externals)) {
    compiler.options.externals.unshift(this.resolveExternal.bind(this));
  }
  compiler.hooks.afterResolvers.tap("npm-install-plugin", compiler => {
    const project_root = process.cwd()
    compiler
      .hooks
      .normalModuleFactory
      .tap('npm-install-plugin', this.installMissingModules.bind(this))
  })

};

NpmInstallPlugin.prototype.install = function(result) {
  if (!result) {
    return;
  }

  var dep = installer.check(result.request);

  if (dep) {
    var dev = this.options.dev;

    if (typeof this.options.dev === "function") {
      dev = !!this.options.dev(result.request, result.path);
    }

    installer.install(dep, Object.assign({}, this.options, { dev: dev }));
  }
}

NpmInstallPlugin.prototype.preCompile = function(compilation, next) {
  if (!this.preCompiler) {
    var options = this.compiler.options;
    var config = Object.assign(
      // Start with new config object
      {},
      // Inherit the current config
      options,
      {
        // Ensure fresh cache
        cache: {},
        // Register plugin to install missing deps
        plugins: [
          new NpmInstallPlugin(this.options),
        ],
      }
    );

    this.preCompiler = webpack(config);
    this.preCompiler.outputFileSystem = new MemoryFS();
  }

  this.preCompiler.run((err, stats) => {
    next()
  });
};

NpmInstallPlugin.prototype.resolveExternal = function(context, request, callback) {
  // Only install direct dependencies, not sub-dependencies
  if (context.match("node_modules")) {
    return callback();
  }

  // Ignore !!bundle?lazy!./something
  if (request.match(/(\?|\!)/)) {
    return callback();
  }

  var result = {
    context: {},
    path: context,
    request: request,
  };

  this.resolve('normal', result, function(err, filepath) {
    if (err) {
      this.install(Object.assign({}, result, { request: depFromErr(err) }));
    }

    callback();
  }.bind(this));
};

NpmInstallPlugin.prototype.resolve = function(normalModuleFactory) {
  var version = require("webpack/package.json").version;
  var major = version.split(".").shift();

  if (major === "1") {
    return this.compiler.resolvers[resolver].resolve(
      result.path,
      result.request,
      callback
    );
  }

  if (major === "2" || major === "3") {
    return this.compiler.resolvers[resolver].resolve(
      result.context || {},
      result.path,
      result.request,
      callback
    );
  }

  throw new Error("Unsupported Webpack version: " + version);
}

NpmInstallPlugin.prototype.resolveLoader = function(result, next) {
  // Only install direct dependencies, not sub-dependencies
  if (result.path.match("node_modules")) {
    return next();
  }

  if (this.resolving[result.request]) {
    return next();
  }

  this.resolving[result.request] = true;

  this.resolve("loader", result, function(err, filepath) {
    this.resolving[result.request] = false;

    if (err) {
      var loader = utils.normalizeLoader(result.request);
      this.install(Object.assign({}, result, { request: loader }));
    }

    return next();
  }.bind(this));
};

NpmInstallPlugin.prototype.resolveModule = function(createdModule, result, next) {
  // Only install direct dependencies, not sub-dependencies
  if (result.path.match("node_modules")) {
    return next();
  }

  if (this.resolving[result.request]) {
    return next();
  }

  this.resolving[result.request] = true;

  this.resolve('normal', result, function(err, filepath) {
    this.resolving[result.request] = false;

    if (err) {
      this.install(Object.assign({}, result, { request: depFromErr(err) }));
    }

    return next();
  }.bind(this));
};

NpmInstallPlugin.prototype.installMissingModules = function(normalModuleFactory) {
  normalModuleFactory
    .hooks
    .resolver
    .tap("npm-install-plugin", prev => (data, callback) => {
      const new_callback = (err, ...args) => {
        if (err) {
          const request = depFromErr(err.toString());
          const dep = installer.check(request)
          installer.install(dep, Object.assign({}, this.options));
        }
        callback(err, ...args)
      }
      prev(data, new_callback)
    })
};

module.exports = NpmInstallPlugin;
