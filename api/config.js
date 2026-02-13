// Vercel Serverless Function: exposes NON-secret runtime config to the client
// Set in Vercel project settings: PAYMASTER_SERVICE_URL
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    paymasterServiceUrl: process.env.PAYMASTER_SERVICE_URL || ""
  });
};
