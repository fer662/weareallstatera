require('dotenv').config();

const express = require('express');
const passport = require('passport');
const Strategy = require('passport-twitter').Strategy;
const TwitterStream = require('twitter-stream-api');
const Twit = require('twit');
const fs = require('fs');

const { Sequelize, DataTypes, Op } = require('sequelize');

let sequelize = null;
let callbackURL = '/oauth/callback';

if (process.env.HEROKU) {
  callbackURL = 'http://weareallstatera.herokuapp.com/oauth/callback';
  sequelize = new Sequelize(process.env.DATABASE_URL)
}
else {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: 'database.sqlite'
  });
}

const User = sequelize.define('User', {
  twitterId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  accessToken: {
    type: DataTypes.STRING,
    allowNull: false
  },
  tokenSecret: {
    type: DataTypes.STRING,
    allowNull: false
  },
}, {
});

let twitterClients = [];

function addTwitterClient(user) {
  console.log(`addTwitterClient: ${user.twitterId}`);
  const client = new Twit({
    consumer_key: process.env['TWITTER_CONSUMER_KEY'],
    consumer_secret: process.env['TWITTER_CONSUMER_SECRET'],
    access_token: user.accessToken,
    access_token_secret: user.tokenSecret,
    timeout_ms: 60 * 1000,
    strictSSL: true,
  })
  twitterClients.push(client)
}

function removeTwitterClient(user) {
  console.log(`removeTwitterClient: ${user.twitterId}`);
  const index = clients.findIndex((u) => {
    u.twitterId == user.twitterId;
  })
  if (index !== undefined) {
    twitterClients = twitterClients.slice(index, index + 1);
  }
}

async function setupDatabase() {
  try {
    await sequelize.authenticate();
    console.log('Connection has been established successfully.');
  } catch (error) {
    console.error('Unable to connect to the database:', error);
  }
  await User.sync({ force: false });
}

var trustProxy = false;
if (process.env.HEROKU) {
  // Apps on heroku are behind a trusted proxy
  trustProxy = true;
}
 
var appClient = new Twit({
  consumer_key: process.env['TWITTER_CONSUMER_KEY'],
  consumer_secret: process.env['TWITTER_CONSUMER_SECRET'],
  access_token: process.env['TWITTER_ACCESS_TOKEN'],
  access_token_secret: process.env['TWITTER_ACCESS_TOKEN_SECRET'],
  timeout_ms: 60 * 1000,
  strictSSL: true,
})

passport.use(new Strategy({
    consumerKey: process.env['TWITTER_CONSUMER_KEY'],
    consumerSecret: process.env['TWITTER_CONSUMER_SECRET'],
    callbackURL: callbackURL,
    proxy: trustProxy
  },
  async (token, tokenSecret, profile, cb) => {
    return cb(null, { twitterId: profile.id, accessToken: token, tokenSecret: tokenSecret });
}));

passport.serializeUser( async (userData, cb) => {
  //console.log(`serialize: ${JSON.stringify(userData)}`);
  let user = await User.findOne({
    where: {
      twitterId: {
        [Op.eq]: userData.twitterId
      }
    }
  });
  if (!user) {
    console.log("Creating user");
    // New user, add to DB
    user = User.build(userData);
    addTwitterClient(user);
    await user.save();
  }
  else {
    // Existing user, update credentials in DB
    console.log("Updating credentials");
    if (user.accessToken !== userData.accessToken || user.tokenSecret !== userData.tokenSecret) {
      removeTwitterClient(user);

      user.accessToken = userData.accessToken;
      user.tokenSecret = userData.tokenSecret;

      await user.save();

      addTwitterClient(user);
    }
  }
  cb(null, user);
});

passport.deserializeUser(async (obj, cb) => {
  const user = await User.findOne({
    where: {
      twitterId: {
        [Op.eq]: obj.twitterId
      }
    }
  });
  cb(null, user);
});

// Create a new Express application.
var app = express();

// Configure view engine to render EJS templates.
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');

app.use(require('morgan')('combined'));
app.use(require('body-parser').urlencoded({ extended: true }));
app.use(require('express-session')({ secret: process.env['SESSION_SECRET'], resave: true, saveUninitialized: true }));

// Initialize Passport and restore authentication state, if any, from the
// session.
app.use(passport.initialize());
app.use(passport.session());

setupDatabase().then(() => {
  return User.findAll();
}).then((users) => {
  users.forEach((user) => addTwitterClient(user));
}).then(() => {
  // Define routes.
  app.get('/',
    function(req, res) {
      res.render('home', { user: req.user, twitterClients: twitterClients });
    });

  app.get('/login',
    function(req, res){
      res.render('login', {twitterClients: twitterClients});
    });

  app.get('/login/twitter',
    passport.authenticate('twitter'));

  app.get('/oauth/callback',
    passport.authenticate('twitter', { failureRedirect: '/login' }),
    function(req, res) {
      res.redirect('/');
    });

  app.get('/profile',
    require('connect-ensure-login').ensureLoggedIn(),
    function(req, res){
      res.render('profile', { user: req.user });
    });

  app.get('/logout',
    function(req, res){
      removeTwitterClient(req.user);
      req.session.destroy(function (err) {
        res.redirect('/');
      });
    });

  const stream = appClient.stream('statuses/filter', { track: '#WeAreAllStatera' })

  stream.on('tweet', function (tweet) {
    console.log(`Tweet with id ${tweet.id_str}`);
    twitterClients.forEach((twitterClient) => {
      twitterClient.post('favorites/create', { id: tweet.id_str }, (error, data, response) => {
        if (error) {
          console.log(`Error liking tweet ${tweet.id_str}: ${error}`)
        }
      });
    })
  })

  app.listen(process.env['PORT'] || 8080);  
});
