var proc = require('child_process')
var execspawn = require('execspawn')
var os = require('os')
var path = require('path')
var fs = require('fs')
var abi = require('node-abi')
var mkdirp = require('mkdirp')
var xtend = require('xtend/immutable')
var tar = require('tar-fs')
var pump = require('pump')

module.exports = prebuildify

function prebuildify (opts, cb) {
  opts = xtend({
    arch: process.env.PREBUILD_ARCH || os.arch(),
    platform: process.env.PREBUILD_PLATFORM || os.platform(),
    strip: process.env.PREBUILD_STRIP === '1',
    stripBin: process.env.PREBUILD_STRIP_BIN || 'strip',
    nodeGyp: process.env.PREBUILD_NODE_GYP || npmbin('node-gyp'),
    shell: process.env.PREBUILD_SHELL || shell(),
    cwd: '.',
    targets: []
  }, opts)

  var targets = resolveTargets(opts.targets, opts.all, opts.napi)

  if (!targets.length) {
    return process.nextTick(cb, new Error('You must specify at least one target'))
  }

  opts = xtend(opts, {
    targets: targets,
    env: xtend(process.env, {
      PREBUILD_ARCH: opts.arch,
      PREBUILD_PLATFORM: opts.platform,
      PREBUILD_STRIP: opts.strip ? '1' : '0',
      PREBUILD_STRIP_BIN: opts.stripBin,
      PREBUILD_NODE_GYP: opts.nodeGyp,
      PREBUILD_SHELL: opts.shell
    }),
    builds: path.join(opts.cwd, 'prebuilds', opts.platform + '-' + opts.arch),
    output: path.join(opts.cwd, 'build', opts.debug ? 'Debug' : 'Release')
  })

  if (opts.arch === 'ia32' && opts.platform === 'linux' && opts.arch !== os.arch()) {
    opts.env.CFLAGS = '-m32'
  }

  mkdirp(opts.builds, function (err) {
    if (err) return cb(err)
    loop(opts, function (err) {
      if (err) return cb(err)

      if (opts.artifacts) return copyRecursive(opts.artifacts, opts.builds, cb)
      return cb()
    })
  })
}

function loop (opts, cb) {
  var next = opts.targets.shift()
  if (!next) return cb()

  run(opts.preinstall, opts, function (err) {
    if (err) return cb(err)

    build(next.target, next.runtime, opts, function (err, filename) {
      if (err) return cb(err)

      run(opts.postinstall, opts, function (err) {
        if (err) return cb(err)

        copySharedLibs(opts.output, opts.builds, opts, function (err) {
          if (err) return cb(err)

          var v = opts.napi ? 'napi' : abi.getAbi(next.target, next.runtime)
          var name = next.runtime + '-' + v + '.node'
          var dest = path.join(opts.builds, name)

          fs.rename(filename, dest, function (err) {
            if (err) return cb(err)

            loop(opts, cb)
          })
        })
      })
    })
  })
}

function copySharedLibs (builds, folder, opts, cb) {
  fs.readdir(builds, function (err, files) {
    if (err) return cb()

    var libs = files.filter(function (name) {
      return /\.dylib$/.test(name) || /\.so(\.\d+)?$/.test(name) || /\.dll$/.test(name)
    })

    loop()

    function loop (err) {
      if (err) return cb(err)
      var next = libs.shift()
      if (!next) return cb()

      strip(path.join(builds, next), opts, function (err) {
        if (err) return cb(err)
        copy(path.join(builds, next), path.join(folder, next), loop)
      })
    }
  })
}

function run (cmd, opts, cb) {
  if (!cmd) return cb()

  var child = execspawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: 'inherit',
    shell: opts.shell
  })

  child.on('exit', function (code) {
    if (code) return cb(spawnError(cmd, code))
    cb()
  })
}

function build (target, runtime, opts, cb) {
  var args = [
    'rebuild',
    '--target=' + target
  ]

  if (opts.arch) {
    args.push('--target_arch=' + opts.arch)
  }

  if (runtime === 'electron') {
    args.push('--runtime=electron')
    args.push('--dist-url=https://atom.io/download/electron')
  }

  if (opts.debug) {
    args.push('--debug')
  } else {
    args.push('--release')
  }

  var child = proc.spawn(opts.nodeGyp, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.quiet ? 'ignore' : 'inherit'
  })

  child.on('exit', function (code) {
    if (code) return cb(spawnError('node-gyp', code))

    findBuild(opts.output, function (err, output) {
      if (err) return cb(err)

      strip(output, opts, function (err) {
        if (err) return cb(err)
        cb(null, output)
      })
    })
  })
}

function findBuild (dir, cb) {
  fs.readdir(dir, function (err, files) {
    if (err) return cb(err)

    files = files.filter(function (name) {
      return /\.node$/i.test(name)
    })

    if (!files.length) return cb(new Error('Could not find build'))
    cb(null, path.join(dir, files[0]))
  })
}

function strip (file, opts, cb) {
  var platform = os.platform()
  if (!opts.strip || (platform !== 'darwin' && platform !== 'linux')) return cb()

  var args = platform === 'darwin' ? [file, '-Sx'] : [file, '--strip-all']
  var child = proc.spawn(opts.stripBin, args, {stdio: 'ignore'})

  child.on('exit', function (code) {
    if (code) return cb(spawnError(opts.stripBin, code))
    cb()
  })
}

function spawnError (name, code) {
  return new Error(name + ' exited with ' + code)
}

function copy (a, b, cb) {
  fs.stat(a, function (err, st) {
    if (err) return cb(err)
    fs.readFile(a, function (err, buf) {
      if (err) return cb(err)
      fs.writeFile(b, buf, function (err) {
        if (err) return cb(err)
        fs.chmod(b, st.mode, cb)
      })
    })
  })
}

function copyRecursive (src, dst, cb) {
  pump(tar.pack(src), tar.extract(dst), cb)
}

function npmbin (name) {
  return os.platform() === 'win32' ? name + '.cmd' : name
}

function shell () {
  return os.platform() === 'android' ? 'sh' : undefined
}

function resolveTargets (targets, all, napi) {
  targets = targets.map(function (v) {
    if (typeof v === 'object' && v !== null) return v
    if (v.indexOf('@') === -1) v = 'node@' + v

    return {
      runtime: v.split('@')[0],
      target: v.split('@')[1].replace(/^v/, '')
    }
  })

  // TODO: also support --lts and get versions from travis
  if (all) {
    targets = abi.supportedTargets.slice(0)
  }

  // Should be the default once napi is stable
  if (napi && targets.length === 0) {
    targets = [
      abi.supportedTargets.filter(onlyNode).pop(),
      abi.supportedTargets.filter(onlyElectron).pop()
    ]

    if (targets[0].target === '9.0.0') targets[0].target = '9.6.1'
  }

  return targets
}

function onlyNode (t) {
  return t.runtime === 'node'
}

function onlyElectron (t) {
  return t.runtime === 'electron'
}
