module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (error) {
    if (request.endsWith('.js')) {
      return options.defaultResolver(request.slice(0, -3), options);
    }
    throw error;
  }
};
