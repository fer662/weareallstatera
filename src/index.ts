require('dotenv').config();

const express = require('express');
const passport = require('passport');
const Strategy = require('passport-twitter').Strategy;
const TwitterStream = require('twitter-stream-api');
const Twit = require('twit');
const fs = require('fs');
const session = require('express-session');
const redis = require('redis')
const RedisStore = require('connect-redis')(session)
const redisClient = redis.createClient(process.env.REDISCLOUD_URL);

import { Op } from 'sequelize';
import { User, Tweet, UserLikes, sequelize, setupDatabase } from './model';

let callbackURL = '/oauth/callback';
if (process.env.HEROKU) {
  callbackURL = 'http://weareallstatera.herokuapp.com/oauth/callback';
}

class WeAreAllStatera {

  private app: any;
  private appClient: any;
  private tweetStream: any;

  constructor() {
   
  }

  async start() {

    this.appClient = new Twit({
      consumer_key: process.env['TWITTER_CONSUMER_KEY'],
      consumer_secret: process.env['TWITTER_CONSUMER_SECRET'],
      access_token: process.env['TWITTER_ACCESS_TOKEN'],
      access_token_secret: process.env['TWITTER_ACCESS_TOKEN_SECRET'],
      timeout_ms: 60 * 1000,
      strictSSL: true,
    })

    await setupDatabase();
    this.setupPassport();
    this.setupTweetStream();
    this.setupRoutes();
  }

  private setupRoutes() {
    const app = express();

    // Configure view engine to render EJS templates.
    app.set('views', __dirname + '/../views');
    app.set('view engine', 'ejs');

    app.use(require('body-parser').urlencoded({ extended: true }));
    app.use(require('express-session')({
      store: new RedisStore({ client: redisClient }),
      secret: process.env['SESSION_SECRET'],
      resave: false,
      saveUninitialized: false,
    }));

    app.use(passport.initialize());
    app.use(passport.session({
      store: new RedisStore({ client: redisClient }),
      secret: process.env['SESSION_SECRET'],
      resave: true,
      saveUninitialized: true,
      cookie : {secure : true},
    }));

    // Initialize Passport and restore authentication state, if any, from the
    // session.
    
    app.get('/', async (req, res) => {
      let pendingTweets;
      if (req.user) {
        pendingTweets = (await this.pendingTweetsForUser(req.user)).length;
        console.log(pendingTweets);
      }
      const users = await User.findAll();
      res.render('home', { user: req.user, pendingTweets: pendingTweets, twitterClients: users.length });
    });

    app.get('/login', async (req, res) => {
      const users = await Tweet.findAll();
      res.render('login', { twitterClients: users.length });
    });

    app.get('/like', async (req, res) =>{
      await this.likeAllPendingTweetsForUser(req.user);
      res.redirect('/');
    });

    app.get('/login/twitter', passport.authenticate('twitter'));

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

    app.get('/logout', async (req, res) =>{
      if (req.user) {
        await req.user.destroy();
      }
        //removeTwitterClient(req.user);
      req.session.destroy(async (err) => {
        res.redirect('/');
      });
    });
    app.listen(8081);    
    this.app = app;
  }

  private setupTweetStream() {
    this.tweetStream = this.appClient.stream('statuses/filter', { track: '#WeAreAllStatera' })

    this.tweetStream.on('tweet', async (t) => {
      let tweet = await Tweet.findOne({
        where: {
          twitterId: {
            [Op.eq]: t.id_str
          }
        }
      });
      if (!tweet) {
        tweet = Tweet.build({ twitterId: t.id_str });
        await tweet.save();
        console.log(`Tweet with id ${t.id_str}`);
      }
    })
  }

  private setupPassport() {
    // Apps on heroku are behind a trusted proxy
    const trustProxy = process.env.HEROKU !== undefined;
    passport.use(new Strategy({
      consumerKey: process.env['TWITTER_CONSUMER_KEY'],
      consumerSecret: process.env['TWITTER_CONSUMER_SECRET'],
      callbackURL: callbackURL,
      proxy: trustProxy
    },
      async (token, tokenSecret, profile, cb) => {
        return cb(null, { twitterId: profile.id, accessToken: token, tokenSecret: tokenSecret, name: profile.displayName });
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
    //    addTwitterClient(user);
        await user.save();
      }
      else {
        // Existing user, update credentials in DB
        console.log("Updating credentials");
        if (user.accessToken !== userData.accessToken || user.tokenSecret !== userData.tokenSecret) {
          //removeTwitterClient(user);

          user.accessToken = userData.accessToken;
          user.tokenSecret = userData.tokenSecret;

          await user.save();

    //      addTwitterClient(user);
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
  }

  private async likeAllPendingTweetsForUser(user: any) {
    console.log(`likeAllPendingTweetsForUser : ${user.twitterId}`);
    const twitterClient = this.twitterClientForUser(user);
    const pendingTweetsForUser = await this.pendingTweetsForUser(user);
    const likePromises = pendingTweetsForUser.map((tweet) => {

      try {
        console.log(`${user.twitterId} liking ${tweet.twitterId}`);
        return new Promise((resolve, reject) => {
          twitterClient.post('favorites/create', { id: tweet.id_str }, (error, data, response) => {
            if (error) {
              console.log(`Error liking tweet ${tweet.id_str}: ${error}`)
              reject(error);
            }
            else {
              resolve();
            }
          });
        }).then(() => {
          return this.userLikedTweet(user, tweet);
        }).catch((e) => {
          //console.log(e);
          return this.userLikedTweet(user, tweet);
        })
      }
      catch(e) {
        console.log(e);
      }
    });

    await Promise.all(likePromises);
  }

  private pendingTweetsForUser(user: any): Promise<any[]> {
    return sequelize.query(`SELECT t.twitterId, t.id FROM Tweets AS t WHERE t.id NOT IN (SELECT ul.TweetId FROM userLikes AS ul WHERE ul.UserId = ${user.id})`, { type: sequelize.QueryTypes.SELECT});
  }

  private userLikedTweet(user: any, tweet: any): Promise<any> {
    const userLike = UserLikes.build({ TweetId: tweet.id, UserId: user.id, date: new Date()});
    return userLike.save();
  }

  private twitterClientForUser(user: any) {
    return new Twit({
      consumer_key: process.env['TWITTER_CONSUMER_KEY'],
      consumer_secret: process.env['TWITTER_CONSUMER_SECRET'],
      access_token: user.accessToken,
      access_token_secret: user.tokenSecret,
      timeout_ms: 60 * 1000,
      strictSSL: true,
    })
  }
}

const weAreAllStatera = new WeAreAllStatera();
weAreAllStatera.start();

