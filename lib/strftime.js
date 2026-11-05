/*
 * lib/strftime.js - locale-independent strftime subset.
 *
 * Runs unchanged in IINA's JavaScriptCore, Node and a WKWebView.
 * Supports %a %A %b %B %c %C %d %e %f %F %H %I %j %k %l %m %M %n %p %P
 * %r %R %s %S %t %T %u %U %V %w %y %Y %z %Z %%.
 * Unknown specifiers are emitted literally ("%q" -> "%q").
 */
(function (root, factory) { if (typeof module === "object" && module) { module.exports = factory(); } else { root.TwitchPlugin = root.TwitchPlugin || {}; root.TwitchPlugin.strftime = factory(); } })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function pad(value, width) {
    var s = String(Math.abs(value));
    while (s.length < width) s = "0" + s;
    return s;
  }

  function spacePad(value, width) {
    var s = String(value);
    while (s.length < width) s = " " + s;
    return s;
  }

  function dayOfYear(date) {
    var start = Date.UTC(date.getFullYear(), 0, 1);
    var current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.floor((current - start) / 86400000) + 1;
  }

  function isoWeekNumber(date) {
    var target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    var day = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - day);
    var yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    return Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
  }

  function weekNumberSunday(date) {
    var yday0 = dayOfYear(date) - 1;
    return Math.floor((yday0 + 7 - date.getDay()) / 7);
  }

  function offsetMinutes(date) {
    return -date.getTimezoneOffset();
  }

  function timezoneOffset(date) {
    var minutes = offsetMinutes(date);
    var sign = minutes < 0 ? "-" : "+";
    var abs = Math.abs(minutes);
    return sign + pad(Math.floor(abs / 60), 2) + pad(abs % 60, 2);
  }

  function timezoneName(date) {
    var text = String(date);
    var match = /\(([^)]+)\)/.exec(text);
    if (match) {
      var name = match[1];
      if (offsetMinutes(date) === 0 && /Universal|Coordinated|Greenwich Mean/i.test(name)) return "UTC";
      var words = name.split(/\s+/);
      var abbr = "";
      for (var i = 0; i < words.length; i++) {
        if (words[i]) abbr += words[i].charAt(0);
      }
      abbr = abbr.toUpperCase();
      if (abbr.length >= 2 && abbr.length <= 5) return abbr;
    }
    var offset = /GMT([+-]\d{4})/.exec(text);
    if (offset) return "GMT" + offset[1];
    var short = /^(?:[A-Za-z]{3,4})/.exec(text);
    return short ? short[0] : "";
  }

  function twelveHour(hours) {
    return hours % 12 === 0 ? 12 : hours % 12;
  }

  /**
   * strftime(format, date) -> string. Uses local time, English names.
   */
  function strftime(format, date) {
    var d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
    if (isNaN(d.getTime())) return "";
    var fmt = format === null || format === undefined ? "" : String(format);
    var out = "";

    for (var i = 0; i < fmt.length; i++) {
      var ch = fmt.charAt(i);
      if (ch !== "%") {
        out += ch;
        continue;
      }
      i++;
      if (i >= fmt.length) {
        out += "%";
        break;
      }
      var spec = fmt.charAt(i);
      switch (spec) {
      case "a": out += DAYS_SHORT[d.getDay()]; break;
      case "A": out += DAYS_LONG[d.getDay()]; break;
      case "b": out += MONTHS_SHORT[d.getMonth()]; break;
      case "B": out += MONTHS_LONG[d.getMonth()]; break;
      case "c": out += strftime("%a %b %e %T %Y", d); break;
      case "C": out += pad(Math.floor(d.getFullYear() / 100), 2); break;
      case "d": out += pad(d.getDate(), 2); break;
      case "e": out += spacePad(d.getDate(), 2); break;
      case "f": out += pad(d.getMilliseconds() * 1000, 6); break;
      case "F": out += strftime("%Y-%m-%d", d); break;
      case "H": out += pad(d.getHours(), 2); break;
      case "I": out += pad(twelveHour(d.getHours()), 2); break;
      case "j": out += pad(dayOfYear(d), 3); break;
      case "k": out += spacePad(d.getHours(), 2); break;
      case "l": out += spacePad(twelveHour(d.getHours()), 2); break;
      case "m": out += pad(d.getMonth() + 1, 2); break;
      case "M": out += pad(d.getMinutes(), 2); break;
      case "n": out += "\n"; break;
      case "p": out += d.getHours() < 12 ? "AM" : "PM"; break;
      case "P": out += d.getHours() < 12 ? "am" : "pm"; break;
      case "r": out += strftime("%I:%M:%S %p", d); break;
      case "R": out += strftime("%H:%M", d); break;
      case "s": out += String(Math.floor(d.getTime() / 1000)); break;
      case "S": out += pad(d.getSeconds(), 2); break;
      case "t": out += "\t"; break;
      case "T": out += strftime("%H:%M:%S", d); break;
      case "u": out += String(d.getDay() === 0 ? 7 : d.getDay()); break;
      case "U": out += pad(weekNumberSunday(d), 2); break;
      case "V": out += pad(isoWeekNumber(d), 2); break;
      case "w": out += String(d.getDay()); break;
      case "y": out += pad(d.getFullYear() % 100, 2); break;
      case "Y": out += String(d.getFullYear()); break;
      case "z": out += timezoneOffset(d); break;
      case "Z": out += timezoneName(d); break;
      case "%": out += "%"; break;
      default: out += "%" + spec;
      }
    }
    return out;
  }

  /**
   * formatTimestamp(msEpoch, format) = strftime(format, new Date(msEpoch)).
   */
  function formatTimestamp(msEpoch, format) {
    var d = new Date(msEpoch);
    if (isNaN(d.getTime())) return "";
    return strftime(format, d);
  }

  return { strftime: strftime, formatTimestamp: formatTimestamp };
});
