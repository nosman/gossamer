import React from "react";
import { Text, TouchableOpacity } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import { ActiveSessions } from "./src/screens/ActiveSessions";
import { SessionDetail } from "./src/screens/SessionDetail";
import { SessionTree } from "./src/screens/SessionTree";
import { Checkpoints } from "./src/screens/Checkpoints";
import { CheckpointDetail } from "./src/screens/CheckpointDetail";

export type RootStackParamList = {
  ActiveSessions: undefined;
  SessionTree: undefined;
  SessionDetail: { sessionId: string; title?: string };
  Checkpoints: undefined;
  CheckpointDetail: { checkpointId: string; title?: string };
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
              options={({ navigation }) => ({
                title: "Claude Sessions",
                headerRight: () => (
                  <React.Fragment>
                    <TouchableOpacity
                      onPress={() => navigation.navigate("Checkpoints")}
                      style={{ marginRight: 10 }}
                    >
                      <Text style={{ fontSize: 16 }}>⬛</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => navigation.navigate("SessionTree")}
                      style={{ marginRight: 14 }}
                    >
                      <Text style={{ fontSize: 18 }}>⬡</Text>
                    </TouchableOpacity>
                  </React.Fragment>
                ),
              })}
            />
            <Stack.Screen
              name="SessionTree"
              component={SessionTree}
              options={{ title: "Session Tree" }}
            />
            <Stack.Screen
              name="SessionDetail"
              component={SessionDetail}
              options={({ route }) => ({
                title: route.params.title ?? route.params.sessionId.slice(0, 8) + "…",
              })}
            />
            <Stack.Screen
              name="Checkpoints"
              component={Checkpoints}
              options={{ title: "Checkpoints" }}
            />
            <Stack.Screen
              name="CheckpointDetail"
              component={CheckpointDetail}
              options={({ route }) => ({
                title: route.params.title ?? route.params.checkpointId,
              })}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
