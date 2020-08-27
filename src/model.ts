
const { Sequelize, DataTypes } = require('sequelize');

let sequelize = null;

if (process.env.HEROKU) {
  sequelize = new Sequelize(process.env.DATABASE_URL)
}
else {
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: 'database.sqlite',
    logging: false
  });
}


const Tweet = sequelize.define('Tweet', {
  twitterId: {
    type: DataTypes.STRING,
    allowNull: false
  }
}, {
});

const User = sequelize.define('User', {
  twitterId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  name: {
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

const UserLikes = sequelize.define('userLikes', {
  date: DataTypes.DATE
})

Tweet.belongsToMany(User, { through: 'userLikes' });
User.belongsToMany(Tweet, { through: 'userLikes' });

async function setupDatabase() {
  try {
    await sequelize.authenticate();
    console.log('Connection has been established successfully.');
  } catch (error) {
    console.error('Unable to connect to the database:', error);
  }
  await User.sync({ force: false });
  await Tweet.sync({ force: false });
  await UserLikes.sync({ force: false });
}

export { Tweet, User, UserLikes, sequelize, setupDatabase };