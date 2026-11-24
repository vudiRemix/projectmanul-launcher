'use strict';
// Правила из version.json Mojang: для каких ОС и с какими флагами брать библиотеку или аргумент.
const os = require('os');
const path = require('path');

const OS_NAME = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform] || process.platform;
const OS_ARCH = process.arch === 'ia32' ? 'x86' : process.arch;

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== OS_NAME) return false;
    if (rule.os.arch && rule.os.arch !== OS_ARCH) return false;
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(os.release())) return false;
      } catch {
        return false;
      }
    }
  }
  if (rule.features) {
    for (const [key, want] of Object.entries(rule.features)) {
      if (Boolean(features[key]) !== want) return false;
    }
  }
  return true;
}

function rulesAllow(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features)) allowed = rule.action === 'allow';
  }
  return allowed;
}

// "group:artifact:version[:classifier][@ext]" -> "group/path/artifact/version/artifact-version[-classifier].ext"
function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return path.posix.join(...group.split('.'), artifact, version, file);
}

// Ключ для дедупликации: одна и та же библиотека без учёта версии.
function libraryKey(name) {
  const [coords] = name.split('@');
  const [group, artifact, , classifier] = coords.split(':');
  return `${group}:${artifact}${classifier ? `:${classifier}` : ''}`;
}

module.exports = { OS_NAME, OS_ARCH, rulesAllow, mavenPath, libraryKey };
