#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');

var async = require('async');
require('epipebomb')();
var flatMap = require('array.prototype.flatmap');
var request = require('request');

flatMap.shim();

var POSM;
try {
   POSM = require('/etc/posm.json');
 } catch (err) {
   POSM = {
     posm_fqdn: 'posm.io',
     webodm_fqdn: 'webodm.posm.io'
   };
 }

var WEBODM_PROJECT_PATH = '/opt/data/webodm/project';

// ignore imagery more than 20 years old..
var cutoffDate = new Date();
cutoffDate.setFullYear(cutoffDate.getFullYear() - 20);

var blacklist = {
};

var whitelist = [
];

var descriptions = {
  'Bing': 'Satellite and aerial imagery.',
  'Mapbox': 'Satellite and aerial imagery.',
  'MAPNIK': 'The default OpenStreetMap layer.'
};

function convertTileJSON(tileJSON, prefix) {
  prefix = prefix || "";

  return {
    attribution: {
      text: tileJSON.attribution
    },
    default: true,
    extent: {
      min_zoom: tileJSON.minzoom,
      max_zoom: tileJSON.maxzoom,
      bbox: {
        min_lon: tileJSON.bounds[0],
        min_lat: tileJSON.bounds[1],
        max_lon: tileJSON.bounds[2],
        max_lat: tileJSON.bounds[3],
      }
    },
    id: tileJSON.id || tileJSON.name,
    name: tileJSON.name,
    description: tileJSON.description,
    type: "tms",
    url: prefix + tileJSON.tiles[0]
  }
}

function convertSources(sources) {
  return sources.concat(whitelist).map(function(source) {
    if (source == null || (source.type !== 'tms' && source.type !== 'bing')) return;
    if (source.id in blacklist) return;

    if (source.end_date) {
      var endDate = new Date(source.end_date),
          isValid = !isNaN(endDate.getTime());
      if (isValid && endDate <= cutoffDate) return;
    }

    var im = {
      id: source.id,
      name: source.name,
      type: source.type,
      template: source.url
    };

    var description = source.description || descriptions[im.id];
    if (description) im.description = description;

    var extent = source.extent || {};
    if (extent.min_zoom || extent.max_zoom) {
      im.scaleExtent = [
        extent.min_zoom || 0,
        extent.max_zoom || 20
      ];
    }

    if (extent.polygon) {
      im.polygon = extent.polygon;
    } else if (extent.bbox) {
      im.polygon = [[
        [extent.bbox.min_lon, extent.bbox.min_lat],
        [extent.bbox.min_lon, extent.bbox.max_lat],
        [extent.bbox.max_lon, extent.bbox.max_lat],
        [extent.bbox.max_lon, extent.bbox.min_lat],
        [extent.bbox.min_lon, extent.bbox.min_lat]
      ]];
    }

    if (source.id === 'mapbox_locator_overlay') {
      im.overzoom = false;
    }

    var attribution = source.attribution || {};
    if (attribution.url) {
      im.terms_url = attribution.url;
    }
    if (attribution.text) {
      im.terms_text = attribution.text;
    }
    if (attribution.html) {
      im.terms_html = attribution.html;
    }

    ['default', 'overlay', 'best'].forEach(function(a) {
      if (source[a]) {
        im[a] = source[a];
      }
    });

    return im;
  }).filter(function(x) {
    return !!x;
  }).sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });
}

var localSources = [];

try {
  localSources = fs.readdirSync('/etc/tessera.conf.d').map(function(cfg) {
    return Object.keys(require(path.join('/etc/tessera.conf.d', cfg)));
  }).reduce(function(a, b) {
    return a.concat(b);
  }, []);
} catch (err) {
  console.warn(err.stack);
}

var webOdmTasks = [];

try {
  webOdmTasks = fs.readdirSync(WEBODM_PROJECT_PATH).flatMap(function(project) {
    return fs.readdirSync(path.join(WEBODM_PROJECT_PATH, project, 'task')).flatMap(function(task) {
      return path.join(project, 'tasks', task);
    })
  });
} catch (err) {
  console.warn(err.stack);
}

async.parallel([
  async.apply(async.mapLimit, localSources, 8, function(src, next) {
    return request.get({
      json: true,
      uri: util.format('http://%s%s/index.json', POSM.posm_fqdn, src)
    }, function(err, rsp, body) {
      if (err) {
        return next(err);
      }

      if (rsp.statusCode !== 200) {
        return next();
      }

      return next(null, convertTileJSON(body));
    });
  }),
  function(done) {
    return request.get({
      json: true,
      uri: util.format('http://%s/imagery', POSM.posm_fqdn)
    }, function(err, rsp, body) {
      if (err) {
        return done(err);
      }

      if (rsp.statusCode !== 200) {
        return done();
      }

      var sources = Object.keys(body).map(function(k) {
        return body[k];
      }).filter(function(tileJSON) {
        return tileJSON.meta.status.ingest.state === 'SUCCESS';
      }).map(function(tileJSON) {
        tileJSON.id = tileJSON.name;
        if (tileJSON.meta.user != null) {
          tileJSON.name = tileJSON.meta.user.name
        }

        return tileJSON;
      }).map(convertTileJSON);

      return done(null, sources);
    });
  },
  async.apply(async.mapLimit, webOdmTasks, 8, function(src, next) {
    return request.get({
      json: true,
      uri: util.format('http://%s/api/projects/%s/orthophoto/tiles.json', POSM.webodm_fqdn, src)
    }, function(err, rsp, body) {
      if (err) {
        return next(err);
      }

      if (rsp.statusCode !== 200) {
        return next();
      }

      return next(null, convertTileJSON(body, util.format("http://%s", POSM.webodm_fqdn)));
    });
  }),
], function(err, results) {
  if (err) {
    throw err;
  }

  var sources = results.reduce(function(a, b) {
    return a.concat(b);
  }, []);

  process.stdout.write(JSON.stringify({
    dataImagery: convertSources(sources)
  }));
})
