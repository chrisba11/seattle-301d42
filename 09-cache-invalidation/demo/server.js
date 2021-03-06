'use strict';

// Application Dependencies
const express = require('express');
const cors = require('cors');
const superagent = require('superagent');
const pg = require('pg');

// Load Environment from .env file
require('dotenv').config();

// Application Setup
const PORT = process.env.PORT;

// Database setup
const client = new pg.Client(process.env.DATABASE_URL);
client.connect();
client.on('err', err => console.log(err));

const app = express();

app.use(cors());

// Route Handlers
app.get('/location', getLocation);
app.get('/weather', getWeather);

// Start the server up on a given port
app.listen(PORT, () => console.log(`Server is listening on ${PORT}`) );



// HELPER FUNCTIONS AND HANDLERS

// Error handler
function handleError(err, res) {
  console.error('ERR', err);
  if (res) res.status(500).send('Sorry, something went wrong');
}

const timeouts = {
  weather: 1000 * 15
}

function deleteByLocationId(table, cityId) {
  const SQL = `DELETE from ${table} WHERE location_id=${cityId}`;
  return client.query(SQL);
}

// ---------- LOCATION ------------- //

// Route Handler
// Therefore, it has (request, response) as parameters
function getLocation(request, response) {

  const locationHandler = {

    query: request.query.data,

    cacheHit: (results) => {
      console.log('Got data from SQL');
      response.send(results.rows[0]);
    },

    cacheMiss: () => {
      Location.fetchLocation(request.query.data)
        .then(data => response.send(data));
    },
  };

  Location.lookupLocation(locationHandler);

}

// Constructor / Normalizer
function Location(query, data) {
  this.search_query = query;
  this.formatted_query = data.formatted_address;
  this.latitude = data.geometry.location.lat;
  this.longitude = data.geometry.location.lng;
}

// Instance Method: Save a location to the DB
Location.prototype.save = function() {
  let SQL = `
    INSERT INTO locations
      (search_query,formatted_query,latitude,longitude) 
      VALUES($1,$2,$3,$4) 
      RETURNING id
  `;
  let values = Object.values(this);
  return client.query(SQL,values);
};

// Static Method: Fetch a location from google
Location.fetchLocation = (query) => {
  const _URL = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GEOCODE_API_KEY}`;
  return superagent.get(_URL)
    .then( data => {
      console.log('Got data from API');
      if ( ! data.body.results.length ) { throw 'No Data'; }
      else {
        // Create an instance and save it
        let location = new Location(query, data.body.results[0]);
        return location.save()
          .then( result => {
            location.id = result.rows[0].id
            return location;
          })
      }
    });
};

// Static Method: Lookup a location in the DB and invoke the proper callback methods based on what you find
Location.lookupLocation = (handler) => {

  const SQL = `SELECT * FROM locations WHERE search_query=$1`;
  const values = [handler.query];

  return client.query( SQL, values )
    .then( results => {
      if( results.rowCount > 0 ) {
        handler.cacheHit(results);
      }
      else {
        handler.cacheMiss();
      }
    })
    .catch( console.error );

};

// ---------- WEATHER ------------- //

// Route Handler
function getWeather(request, response) {

  const handler = {

    location: request.query.data,

    cacheHit: function(result) {
      let ageOfResults = (Date.now() - result.rows[0].created_at);
      console.log('result.rows', result.rows[0].created_at)
      console.log('age', ageOfResults);
      console.log('timeout', timeouts.weather);

      if( ageOfResults > timeouts.weather ) {
      // if results are stale
        // remove stale data
        Weather.deleteByLocationId('weathers', this.location.id);
        // deleteByLocationId('weathers', request.query.data.id);
        // request new data
        this.cacheMiss();
      } else {
        response.send(result.rows);
      }
    },

    cacheMiss: function() {
      Weather.fetch(request.query.data)
        .then( results => response.send(results) )
        .catch( console.error );
    },
  };

  Weather.lookup(handler);

}

// Weather Constructor/Normalizer
function Weather(day) {
  this.forecast = day.summary;
  this.time = new Date(day.time * 1000).toString().slice(0, 15);
  this.created_at = Date.now();
}

// Share the delete method with all constructors
Weather.deleteByLocationId = deleteByLocationId;

// Instance Method: Save a location to the DB
Weather.prototype.save = function(id) {
  const SQL = `INSERT INTO weathers (forecast, time, created_at, location_id) VALUES ($1, $2, $3, $4);`;
  // const values = Object.values(this);
  // values.push(id);
  const values = [this.forecast, this.time, this.created_at, id];
  client.query(SQL, values);
};

// Static Method: Lookup a location in the DB and invoke the proper callback methods based on what you find
// Question -- is anything in here other than the table name esoteric to weather? Is there an opportunity to DRY this out?
Weather.lookup = function(handler) {
  const SQL = `SELECT * FROM weathers WHERE location_id=$1;`;
  const values = [handler.location.id];
  
  client.query(SQL, values)
    .then(result => {
      if(result.rowCount > 0) {
        console.log('Got data from SQL');
        handler.cacheHit(result);
      } else {
        console.log('Got data from API');
        handler.cacheMiss();
      }
    })
    .catch(error => handleError(error));
};

// Static Method: Fetch a location from the weather API
Weather.fetch = function(location) {
  const url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${location.latitude},${location.longitude}`;

  return superagent.get(url)
    .then(result => {
      const weatherSummaries = result.body.daily.data.map(day => {
        const summary = new Weather(day);
        summary.save(location.id);
        return summary;
      });
      return weatherSummaries;
    });
};
