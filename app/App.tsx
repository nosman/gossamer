import React from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import { ActiveSessions } from "./src/screens/ActiveSessions";
import { SessionDetail } from "./src/screens/SessionDetail";

export type RootStackParamList = {
  ActiveSessions: undefined;
  SessionDetail: { sessionId: string; title?: string };
};

const Stack = createStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationContainer>
          <Stack.Navigator>
            <Stack.Screen
              name="ActiveSessions"
              component={ActiveSessions}
              options={{ title: "Claude Sessions" }}
            />
            <Stack.Screen
              name="SessionDetail"
              component={SessionDetail}
              options={({ route }) => ({
                title: route.params.title ?? route.params.sessionId.slice(0, 8) + "…",
              })}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
