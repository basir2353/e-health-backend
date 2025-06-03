const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  // Try Authorization header first
  let token = null;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.headers['x-auth-token']) {
    // fallback to x-auth-token header
    token = req.headers['x-auth-token'];
  }

  if (!token) {
    console.log('❌ No token, authorization denied');
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    console.log('✅ Token verified. User:', decoded);
    next();
  } catch (err) {
    console.log('❌ Token verification failed:', err.message);
    res.status(401).json({ message: 'Token is not valid' });
  }
};
