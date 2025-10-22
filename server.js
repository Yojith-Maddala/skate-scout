const express = require('express');
const cors = require('cors');
const path = require('path');
const { Client } = require('@googlemaps/google-maps-services-js');
require('dotenv').config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const googleMapsClient = new Client({});

// Constants
const SKATEBOARD_SPEED_KMH = 15;
const WALKING_SPEED_KMH = 5;

// Store reports in memory
let globalReports = [];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const countTurns = (route) => {
  let turnCount = 0;
  
  route.legs.forEach((leg) => {
    leg.steps.forEach((step) => {
      const maneuver = step.maneuver || '';
      
      if (
        /turn-left|turn-right/.test(maneuver) &&
        !/slight/.test(maneuver)
      ) {
        turnCount++;
      }
      
      if (/roundabout|fork/.test(maneuver)) {
        turnCount++;
      }
    });
  });
  
  return turnCount;
};

// Get elevation for a single point
const getElevation = async (lat, lng) => {
  try {
    const response = await googleMapsClient.elevation({
      params: {
        locations: [`${lat},${lng}`],
        key: process.env.GOOGLE_MAPS_API_KEY,
      },
    });
    
    if (response.data.status !== 'OK' || response.data.results.length === 0) {
      console.error('Elevation API error:', response.data.status);
      return null;
    }
    
    return response.data.results[0].elevation;
  } catch (error) {
    console.error('Error fetching elevation:', error.message);
    return null;
  }
};

// Calculate elevation difference and difficulty
const calculateElevationDifference = async (startLat, startLng, endLat, endLng) => {
  try {
    const startElevation = await getElevation(startLat, startLng);
    const endElevation = await getElevation(endLat, endLng);
    
    if (startElevation === null || endElevation === null) {
      return {
        difference: 0,
        direction: 'flat',
        difficulty: 'unknown',
        difficultyColor: '#999',
        startElevation: 0,
        endElevation: 0
      };
    }
    
    const difference = endElevation - startElevation;
    const absDifference = Math.abs(difference);
    
    let direction = 'flat';
    if (difference > 1) {
      direction = 'uphill';
    } else if (difference < -1) {
      direction = 'downhill';
    }
    
    // Calculate difficulty based on elevation change
    let difficulty = 'flat';
    let difficultyColor = '#2196F3'; // Blue
    
    if (absDifference < 3) {
      difficulty = 'flat';
      difficultyColor = '#2196F3'; // Blue
    } else if (absDifference < 8) {
      difficulty = 'easy';
      difficultyColor = '#4CAF50'; // Green
    } else if (absDifference < 15) {
      difficulty = 'moderate';
      difficultyColor = '#FF9800'; // Orange
    } else if (absDifference < 25) {
      difficulty = 'hard';
      difficultyColor = '#FF5722'; // Deep Orange
    } else {
      difficulty = 'very hard';
      difficultyColor = '#F44336'; // Red
    }
    
    return {
      difference: Math.round(difference * 10) / 10,
      absDifference: Math.round(absDifference * 10) / 10,
      direction,
      difficulty,
      difficultyColor,
      startElevation: Math.round(startElevation * 10) / 10,
      endElevation: Math.round(endElevation * 10) / 10
    };
  } catch (error) {
    console.error('Error calculating elevation:', error);
    return {
      difference: 0,
      direction: 'flat',
      difficulty: 'unknown',
      difficultyColor: '#999',
      startElevation: 0,
      endElevation: 0
    };
  }
};

const calculateCalories = (distanceKm, skateTimeMinutes, elevationData) => {
  // Base calorie burn from skateboarding (6 cal/min average)
  const baseCalories = skateTimeMinutes * 6;
  
  // Distance-based calories (45 cal/km average)
  const distanceCalories = distanceKm * 45;
  
  // Elevation adjustment
  let elevationCalories = 0;
  
  if (elevationData && elevationData.difference !== undefined) {
    if (elevationData.difference > 0) {
      // Uphill: significant calorie increase (10 cal per meter)
      elevationCalories = elevationData.difference * 10;
    } else if (elevationData.difference < 0) {
      // Downhill: slight reduction but still requires effort for control
      // Use 2 cal per meter (maintaining balance, braking)
      elevationCalories = Math.abs(elevationData.difference) * 2;
    }
  }
  
  // Combine all factors (use average of base and distance, then add elevation)
  const totalCalories = Math.round((baseCalories + distanceCalories) / 2 + elevationCalories);
  
  return totalCalories;
};

/**
 * Calculate time adjustment based on congestion reports
 * Congestion levels: 1 (empty) to 5 (packed)
 * Higher congestion = slower skateboarding speed
 */
const calculateCongestionTimeAdjustment = (route, reports) => {
  if (!reports || reports.length === 0) {
    return 1.0; // No adjustment
  }
  
  const polyline = route.overview_polyline.points;
  const coordinates = decodePolyline(polyline);
  
  let totalCongestion = 0;
  let congestionCount = 0;
  
  reports.forEach(report => {
    if (report.type === 'congestion' && report.congestion) {
      const nearRoute = isPointNearPolyline(
        { lat: report.lat, lng: report.lng },
        coordinates,
        0.05 // 50 meter threshold
      );
      
      if (nearRoute) {
        totalCongestion += report.congestion;
        congestionCount++;
      }
    }
  });
  
  if (congestionCount === 0) {
    return 1.0; // No congestion reports on this route
  }
  
  const avgCongestion = totalCongestion / congestionCount;
  
  // Time multiplier based on congestion
  // 1 (empty) = 1.0x (no change)
  // 2 (light) = 1.1x (10% slower)
  // 3 (moderate) = 1.25x (25% slower)
  // 4 (busy) = 1.5x (50% slower)
  // 5 (packed) = 2.0x (100% slower - twice as long)
  
  const multiplier = 1 + (avgCongestion - 1) * 0.25;
  
  return multiplier;
};

const calculateSmoothnessScore = (route, reports) => {
  if (!reports || reports.length === 0) {
    return 5.0;
  }
  const polyline = route.overview_polyline.points;
  const coordinates = decodePolyline(polyline);
  
  let totalRating = 0;
  let ratingCount = 0;
  
  reports.forEach(report => {
    if (report.type === 'smoothness' && report.rating) {
      const nearRoute = isPointNearPolyline(
        { lat: report.lat, lng: report.lng },
        coordinates,
        0.05
      );
      
      if (nearRoute) {
        totalRating += report.rating;
        ratingCount++;
      }
    }
  });
  
  return ratingCount > 0 ? totalRating / ratingCount : 5.0;
};

const isRouteBlocked = (route, reports) => {
  if (!reports || reports.length === 0) {
    return false;
  }
  
  const polyline = route.overview_polyline.points;
  const coordinates = decodePolyline(polyline);
  
  for (const report of reports) {
    if (report.type === 'construction' || report.type === 'blocked') {
      const nearRoute = isPointNearPolyline(
        { lat: report.lat, lng: report.lng },
        coordinates,
        0.05
      );
      
      if (nearRoute) {
        return true;
      }
    }
  }
  
  return false;
};

function decodePolyline(encoded) {
  if (!encoded) return [];
  
  let points = [];
  let index = 0, len = encoded.length;
  let lat = 0, lng = 0;
  
  while (index < len) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;
    
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;
    
    points.push([lat / 1e5, lng / 1e5]);
  }
  
  return points;
}

function isPointNearPolyline(point, polylinePoints, thresholdKm) {
  for (let i = 0; i < polylinePoints.length - 1; i++) {
    const [lat1, lng1] = polylinePoints[i];
    const [lat2, lng2] = polylinePoints[i + 1];
    
    const distance = distanceToSegment(
      point.lat, point.lng,
      lat1, lng1,
      lat2, lng2
    );
    
    if (distance < thresholdKm) {
      return true;
    }
  }
  return false;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const A = px - x1;
  const B = py - y1;
  const C = x2 - x1;
  const D = y2 - y1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;
  
  if (lenSq !== 0) {
    param = dot / lenSq;
  }
  
  let xx, yy;
  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }
  
  return calculateDistance(px, py, xx, yy);
}

function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

const calculateRoughness = (route, reports) => {
  let totalSteps = 0;
  route.legs.forEach((leg) => {
    totalSteps += leg.steps.length;
  });
  
  const baseRoughness = totalSteps * Math.random() * 0.5;
  const smoothnessScore = calculateSmoothnessScore(route, reports);
  const roughnessFromReports = (5 - smoothnessScore) * 2;
  
  return baseRoughness + roughnessFromReports;
};

const calculateSkateboardTime = (route) => {
  const distanceKm = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0) / 1000;
  return (distanceKm / SKATEBOARD_SPEED_KMH) * 60;
};

const geocodeAddress = async (address) => {
  try {
    const response = await googleMapsClient.geocode({
      params: {
        address: address,
        key: process.env.GOOGLE_MAPS_API_KEY,
      },
    });
    
    if (response.data.results.length === 0) {
      throw new Error(`Could not geocode address: ${address}`);
    }
    
    return response.data.results[0].geometry.location;
  } catch (error) {
    console.error('Geocoding error:', error.message);
    throw error;
  }
};

// TAMU-specific major intersection waypoints
const TAMU_MAJOR_INTERSECTIONS = [
  { lat: 30.6200, lng: -96.3400, name: 'Joe Routt & Lamar' },
  { lat: 30.6180, lng: -96.3380, name: 'University & Lamar' },
  { lat: 30.6150, lng: -96.3420, name: 'Houston & Lamar' },
  { lat: 30.6170, lng: -96.3360, name: 'University & Ross' },
  { lat: 30.6190, lng: -96.3440, name: 'Spence & Lamar' },
  { lat: 30.6210, lng: -96.3390, name: 'Joe Routt & Lubbock' },
];

const calculateRightAngleWaypoints = (startCoords, endCoords) => {
  const waypoints = [];
  
  // Calculate the vector from start to end
  const deltaLat = endCoords.lat - startCoords.lat;
  const deltaLng = endCoords.lng - startCoords.lng;
  
  // Option 1: Go "east-west" first (45° diagonal), then "north-south" (135° diagonal)
  const waypoint1 = {
    lat: startCoords.lat + deltaLat,
    lng: startCoords.lng + deltaLat,
    description: 'Via diagonal (45°) then perpendicular (135°)'
  };
  
  // Option 2: Go "north-south" first (135° diagonal), then "east-west" (45° diagonal)
  const waypoint2 = {
    lat: startCoords.lat - deltaLng,
    lng: startCoords.lng + deltaLng,
    description: 'Via diagonal (135°) then perpendicular (45°)'
  };
  
  waypoints.push(waypoint1, waypoint2);
  
  // Also check TAMU intersections that align with 45-degree grid
  TAMU_MAJOR_INTERSECTIONS.forEach(intersection => {
    const latDiffStart = intersection.lat - startCoords.lat;
    const lngDiffStart = intersection.lng - startCoords.lng;
    const latDiffEnd = endCoords.lat - intersection.lat;
    const lngDiffEnd = endCoords.lng - intersection.lng;
    
    const ratio1 = Math.abs(latDiffStart / lngDiffStart);
    const ratio2 = Math.abs(latDiffEnd / lngDiffEnd);
    
    if ((ratio1 > 0.8 && ratio1 < 1.2) || (ratio2 > 0.8 && ratio2 < 1.2)) {
      waypoints.push({
        lat: intersection.lat,
        lng: intersection.lng,
        description: `Via ${intersection.name} (diagonal grid)`
      });
    }
  });
  
  return waypoints.slice(0, 3);
};

const calculateDiagonalWaypoints = (startCoords, endCoords) => {
  const waypoints = [];
  const ratios = [0.33, 0.5, 0.67];
  
  ratios.forEach(ratio => {
    waypoints.push({
      lat: startCoords.lat + (endCoords.lat - startCoords.lat) * ratio,
      lng: startCoords.lng + (endCoords.lng - startCoords.lng) * ratio,
      description: `${(ratio * 100).toFixed(0)}% along direct path`
    });
  });
  
  return waypoints;
};

// ============================================================================
// ROUTE FETCHING FUNCTIONS
// ============================================================================

const getRouteWithMetrics = async (start, end, reports) => {
  try {
    const response = await googleMapsClient.directions({
      params: {
        origin: start,
        destination: end,
        mode: 'walking',
        key: process.env.GOOGLE_MAPS_API_KEY,
        alternatives: true,
      },
    });
    
    if (response.data.status !== 'OK') {
      throw new Error(`Directions API error: ${response.data.status}`);
    }
    
    const routes = response.data.routes;
    console.log(`Found ${routes.length} alternative route(s)`);
    
    const routeMetrics = await Promise.all(routes.map(async (route, index) => {
      const distance = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0) / 1000;
      const walkingTime = route.legs.reduce((sum, leg) => sum + leg.duration.value, 0) / 60;
      const numTurns = countTurns(route);
      const roughness = calculateRoughness(route, reports);
      const baseSkateTime = calculateSkateboardTime(route);
      const blocked = isRouteBlocked(route, reports);
      const smoothnessScore = calculateSmoothnessScore(route, reports);
      
      // Get congestion adjustment
      const congestionMultiplier = calculateCongestionTimeAdjustment(route, reports);
      const skateTime = baseSkateTime * congestionMultiplier;
      const hasCongestion = congestionMultiplier > 1.0;
      
      // Get elevation difference
      const polyline = route.overview_polyline.points;
      const coordinates = decodePolyline(polyline);
      const startCoord = coordinates[0];
      const endCoord = coordinates[coordinates.length - 1];
      
      const elevation = await calculateElevationDifference(
        startCoord[0], startCoord[1],
        endCoord[0], endCoord[1]
      );
      
      const calories = calculateCalories(distance, skateTime, elevation);
      
      return {
        index,
        distance,
        walkingTime,
        skateTime,
        baseSkateTime,
        congestionMultiplier,
        hasCongestion,
        numTurns,
        roughness,
        smoothnessScore,
        blocked,
        polyline,
        route,
        type: 'regular',
        description: `Regular route ${index}`,
        elevation,
        calories,
      };
    }));
    
    return routeMetrics;
  } catch (error) {
    console.error('Error fetching routes:', error.message);
    throw error;
  }
};

const getRouteWithWaypoint = async (start, end, waypoint, description, index, reports) => {
  try {
    const response = await googleMapsClient.directions({
      params: {
        origin: start,
        destination: end,
        waypoints: [`${waypoint.lat},${waypoint.lng}`],
        mode: 'walking',
        key: process.env.GOOGLE_MAPS_API_KEY,
        optimize: false,
      },
    });
    
    if (response.data.status !== 'OK') {
      return null;
    }
    
    const route = response.data.routes[0];
    const numTurns = countTurns(route);
    const distance = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0) / 1000;
    const duration = route.legs.reduce((sum, leg) => sum + leg.duration.value, 0) / 60;
    const baseSkateTime = calculateSkateboardTime(route);
    
    // Get congestion adjustment
    const congestionMultiplier = calculateCongestionTimeAdjustment(route, reports);
    const skateTime = baseSkateTime * congestionMultiplier;
    const hasCongestion = congestionMultiplier > 1.0;
    
    const roughness = calculateRoughness(route, reports);
    const walkingTime = duration;
    const blocked = isRouteBlocked(route, reports);
    const smoothnessScore = calculateSmoothnessScore(route, reports);
    
    // Get elevation difference
    const polyline = route.overview_polyline.points;
    const coordinates = decodePolyline(polyline);
    const startCoord = coordinates[0];
    const endCoord = coordinates[coordinates.length - 1];
    
    const elevation = await calculateElevationDifference(
      startCoord[0], startCoord[1],
      endCoord[0], endCoord[1]
    );
    
    const calories = calculateCalories(distance, skateTime, elevation);
    
    return {
      index,
      waypoint,
      description,
      route,
      numTurns,
      distance,
      walkingTime,
      duration,
      skateTime,
      baseSkateTime,
      congestionMultiplier,
      hasCongestion,
      roughness,
      smoothnessScore,
      blocked,
      polyline,
      type: 'waypoint',
      elevation,
      calories,
    };
  } catch (error) {
    console.error('Error with waypoint route:', error.message);
    return null;
  }
};

const getAllWaypointRoutes = async (start, end, reports) => {
  try {
    console.log('  Calculating waypoint routes...');
    
    const startCoords = await geocodeAddress(start);
    const endCoords = await geocodeAddress(end);
    
    const rightAngleWaypoints = calculateRightAngleWaypoints(startCoords, endCoords);
    const diagonalWaypoints = calculateDiagonalWaypoints(startCoords, endCoords);
    const allWaypoints = [...rightAngleWaypoints, ...diagonalWaypoints];
    
    console.log(`  Testing ${allWaypoints.length} waypoint configurations...`);
    
    const routePromises = allWaypoints.map(async (waypointConfig, idx) => {
      return await getRouteWithWaypoint(
        `${startCoords.lat},${startCoords.lng}`,
        `${endCoords.lat},${endCoords.lng}`,
        { lat: waypointConfig.lat, lng: waypointConfig.lng },
        waypointConfig.description,
        -(idx + 1),
        reports
      );
    });
    
    const routes = (await Promise.all(routePromises)).filter(r => r !== null);
    
    console.log(`  Found ${routes.length} valid waypoint routes\n`);
    
    return routes;
    
  } catch (error) {
    console.error('Error with waypoint routes:', error.message);
    return [];
  }
};

const getAllRoutes = async (start, end, reports) => {
  try {
    console.log('🔍 Fetching all route options...\n');
    
    console.log('📍 Fetching regular routes...');
    const regularRoutes = await getRouteWithMetrics(start, end, reports);
    
    console.log('🎯 Fetching waypoint routes...');
    const waypointRoutes = await getAllWaypointRoutes(start, end, reports);
    
    const allRoutes = [...regularRoutes, ...waypointRoutes];
    
    console.log(`✅ Total routes found: ${allRoutes.length} (${regularRoutes.length} regular + ${waypointRoutes.length} waypoint)\n`);
    
    return allRoutes;
    
  } catch (error) {
    console.error('Error getting all routes:', error.message);
    throw error;
  }
};

// ============================================================================
// ROUTE ANALYSIS FUNCTIONS
// ============================================================================

const findOptimalPaths = async (start, end, reports) => {
  const allRoutes = await getAllRoutes(start, end, reports);
  
  if (allRoutes.length === 0) {
    return { error: 'No routes found' };
  }
  
  const availableRoutes = allRoutes.filter(route => !route.blocked);
  const routesToConsider = availableRoutes.length > 0 ? availableRoutes : allRoutes;
  
  const shortestPath = routesToConsider.reduce((min, route) => 
    route.skateTime < min.skateTime ? route : min, routesToConsider[0]);
  
  const safestPath = routesToConsider.reduce((min, route) => 
    route.numTurns < min.numTurns ? route : min, routesToConsider[0]);
  
  const smoothestPath = routesToConsider.reduce((best, route) => {
    const currentScore = route.smoothnessScore - (route.roughness / 10);
    const bestScore = best.smoothnessScore - (best.roughness / 10);
    return currentScore > bestScore ? route : best;
  }, routesToConsider[0]);
  
  const maxTurns = Math.max(...routesToConsider.map(r => r.numTurns), 1);
  const maxRoughness = Math.max(...routesToConsider.map(r => r.roughness), 1);
  
  const balancedPath = routesToConsider.reduce((min, route) => {
    const normalizedScore = (route.numTurns / maxTurns + route.roughness / maxRoughness) / 2;
    return normalizedScore < (min.normalizedScore || Infinity) 
      ? { ...route, normalizedScore }
      : min;
  }, { normalizedScore: Infinity });
  
  const singleTurnRoutes = routesToConsider.filter(r => r.numTurns === 1);
  const singleTurnPath = singleTurnRoutes.length > 0
    ? singleTurnRoutes.reduce((min, route) => 
        route.distance < min.distance ? route : min, singleTurnRoutes[0])
    : null;
  
  return {
    shortestPath,
    safestPath,
    smoothestPath,
    balancedPath,
    singleTurnPath,
    allRoutes,
  };
};

// ============================================================================
// API ENDPOINTS
// ============================================================================

app.post('/api/routes', async (req, res) => {
    try {
        const { start, end, reports } = req.body;
        
        if (!start || !end) {
            return res.status(400).json({ error: 'Start and end locations are required' });
        }
        
        const allReports = [...globalReports, ...(reports || [])];
        
        console.log(`\n${'='.repeat(70)}`);
        console.log(`🛹 Finding routes from:`);
        console.log(`   Start: ${start}`);
        console.log(`   End: ${end}`);
        console.log(`   Active reports: ${allReports.length}`);
        console.log('='.repeat(70));
        
        const paths = await findOptimalPaths(start, end, allReports);
        
        if (paths.error) {
            return res.status(404).json(paths);
        }
        
        console.log(`\n✅ Routes found successfully!`);
        console.log(`   Shortest: ${paths.shortestPath.distance.toFixed(2)}km, ${paths.shortestPath.skateTime.toFixed(1)}min, ${paths.shortestPath.numTurns} turns, ${paths.shortestPath.calories}cal, ${paths.shortestPath.elevation.direction} ${paths.shortestPath.elevation.absDifference}m ${paths.shortestPath.blocked ? '⚠️ BLOCKED' : ''}`);
        console.log(`   Safest: ${paths.safestPath.distance.toFixed(2)}km, ${paths.safestPath.skateTime.toFixed(1)}min, ${paths.safestPath.numTurns} turns, ${paths.safestPath.calories}cal, ${paths.safestPath.elevation.direction} ${paths.safestPath.elevation.absDifference}m ${paths.safestPath.blocked ? '⚠️ BLOCKED' : ''}`);
        console.log(`   Smoothest: ${paths.smoothestPath.distance.toFixed(2)}km, ${paths.smoothestPath.skateTime.toFixed(1)}min, smoothness ${paths.smoothestPath.smoothnessScore.toFixed(1)}/5, ${paths.smoothestPath.calories}cal, ${paths.smoothestPath.elevation.direction} ${paths.smoothestPath.elevation.absDifference}m ${paths.smoothestPath.blocked ? '⚠️ BLOCKED' : ''}`);
        console.log(`   Balanced: ${paths.balancedPath.distance.toFixed(2)}km, ${paths.balancedPath.skateTime.toFixed(1)}min, ${paths.balancedPath.numTurns} turns, ${paths.balancedPath.calories}cal, ${paths.balancedPath.elevation.direction} ${paths.balancedPath.elevation.absDifference}m ${paths.balancedPath.blocked ? '⚠️ BLOCKED' : ''}`);
        if (paths.singleTurnPath) {
            console.log(`   Single Turn: ${paths.singleTurnPath.distance.toFixed(2)}km, ${paths.singleTurnPath.skateTime.toFixed(1)}min, ${paths.singleTurnPath.numTurns} turn, ${paths.singleTurnPath.calories}cal, ${paths.singleTurnPath.elevation.direction} ${paths.singleTurnPath.elevation.absDifference}m ${paths.singleTurnPath.blocked ? '⚠️ BLOCKED' : '✅'}`);
        }
        console.log('='.repeat(70) + '\n');
        
        const cleanPaths = {
            shortestPath: cleanRoute(paths.shortestPath),
            safestPath: cleanRoute(paths.safestPath),
            smoothestPath: cleanRoute(paths.smoothestPath),
            balancedPath: cleanRoute(paths.balancedPath),
            singleTurnPath: paths.singleTurnPath ? cleanRoute(paths.singleTurnPath) : null,
            allRoutes: paths.allRoutes.map(cleanRoute)
        };
        
        res.json(cleanPaths);
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

app.post('/api/reports', (req, res) => {
    try {
        const report = req.body;
        
        if (!report.lat || !report.lng || !report.type) {
            return res.status(400).json({ error: 'Invalid report data' });
        }
        
        globalReports.push(report);
        
        console.log(`📍 New report received: ${report.type} at (${report.lat.toFixed(4)}, ${report.lng.toFixed(4)})`);
        
        res.json({ success: true, report });
    } catch (error) {
        console.error('Error saving report:', error);
        res.status(500).json({ error: 'Failed to save report' });
    }
});

app.delete('/api/reports/:id', (req, res) => {
    try {
        const reportId = parseInt(req.params.id);
        
        const index = globalReports.findIndex(r => r.id === reportId);
        
        if (index === -1) {
            return res.status(404).json({ error: 'Report not found' });
        }
        
        const deletedReport = globalReports.splice(index, 1)[0];
        
        console.log(`🗑️  Report deleted: ${deletedReport.type} (ID: ${reportId})`);
        
        res.json({ success: true, deletedReport });
    } catch (error) {
        console.error('Error deleting report:', error);
        res.status(500).json({ error: 'Failed to delete report' });
    }
});

app.get('/api/reports', (req, res) => {
    res.json(globalReports);
});

function cleanRoute(route) {
    const { route: fullRoute, ...cleanedRoute } = route;
    return {
        ...cleanedRoute,
        calories: route.calories
    };
}

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Server is running',
        reports: globalReports.length 
    });
});

// HTML PAGE ROUTES
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/map', (req, res) => {
    res.sendFile(path.join(__dirname, 'map.html'));
});

app.get('/map.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'map.html'));
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(port, () => {
    console.log('\n' + '='.repeat(70));
    console.log(`🚀 Skate Scout Server`);
    console.log('='.repeat(70));
    console.log(`✅ Server running on http://localhost:${port}`);
    console.log(`🏠 Landing page: http://localhost:${port}`);
    console.log(`🗺️  Map page: http://localhost:${port}/map.html`);
    console.log(`📍 API endpoint: POST http://localhost:${port}/api/routes`);
    console.log(`📝 Reports endpoint: POST http://localhost:${port}/api/reports`);
    console.log(`🏥 Health check: GET http://localhost:${port}/api/health`);
    console.log('='.repeat(70));
});